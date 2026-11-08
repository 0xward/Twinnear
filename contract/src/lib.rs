//! Twinnear — gasless freelancer invoicing on NEAR.
//!
//! - Sellers create invoices for a client (amount in yoctoNEAR for the MVP;
//!   USDC settlement via 1Click/Intents is a frontend module).
//! - Clients pay: funds are held in escrow inside this contract.
//! - Sellers release escrowed funds once work is delivered, or refund the
//!   client. Refund is only possible while funds are still escrowed.
//! - Escrow has an optional deadline (`due_days` at creation): after it,
//!   the client can claim a refund themselves (`claim_refund`) — funds
//!   are never locked forever if the seller disappears. The client can
//!   also open a dispute, which blocks `release_invoice` until withdrawn
//!   or refunded. There is NO automatic refund: a NEAR contract cannot
//!   wake itself up, so every recovery is triggered by one human click
//!   (known limitation, documented in README).
//! - Spend-guard (rule-based, no AI): any account can set a policy for
//!   itself — a max amount per invoice, an allowlist of sellers, and a
//!   max total per day, in NEAR and (v4) in USDC. The policy is
//!   enforced at creation AND re-checked at payment time; the daily
//!   cap is accounted in `pay_invoice` (NEAR) and in
//!   `confirm_external_payment` (USDC). External (1Click) settlements
//!   never touch escrow, so the guard cannot verify the receipt —
//!   the seller attests it — but the USDC caps still apply to the
//!   amounts the seller can invoice and confirm.
//! - Gasless meta-transactions (phase 2): a trusted relayer account (set by
//!   the owner) may create invoices on a seller's behalf via
//!   `create_invoice_meta`. The seller's NEP-413 ed25519 signature is
//!   verified ON-CHAIN (M-01) over the canonical message; the contract
//!   enforces replay protection with a per-seller nonce and only accepts
//!   calls from the relayer account.
//! - External settlement (phase 2): when a client pays from another chain
//!   via 1Click/Intents, the funds land directly with the seller (no
//!   escrow). The seller then closes the invoice on-chain with
//!   `confirm_external_payment`, attesting receipt and recording the
//!   1Click deposit address / tx reference.
//! - Anti-spam (H-06): direct `create_invoice` requires a 0.01 NEAR
//!   storage deposit (one-time, non-refundable — it pays for the permanent
//!   ledger entry); at most 50 open (Pending) invoices per seller; the
//!   contract tracks total escrow and refuses new invoices when the
//!   liquid balance (total minus storage-locked, minus escrow) would
//!   fall below a reserve, so spam can never make a release/refund
//!   fail for lack of funds.
//! - Escrow transfers (H-02) use a callback: the invoice is only marked
//!   released/refunded when the transfer promise succeeds. A failed
//!   transfer leaves the escrow claimable again (retry by calling
//!   release/refund again) or rescuable by the owner (`rescue_escrow`).
//! - Funded milestones (v5, NEAR only): an invoice may be split into at
//!   most 5 milestones; the client pays the FULL amount into escrow up
//!   front, then the seller submits work per milestone and the client
//!   approves it — approval releases that milestone's funds
//!   immediately. If the client stays silent for 14 days after a
//!   submission, the seller may claim the milestone (`claim_milestone`).
//!   A dispute blocks approval/claim/release of unreleased milestones.
//!   A refund returns only the still-unreleased portion.
//! - Programmable splits (v5, NEAR only): an invoice may define at most
//!   3 split recipients (shares sum to exactly 10000 bps); every
//!   milestone release and every full-invoice release distributes the
//!   released amount by the splits instead of paying the seller alone.
//!   Milestones and splits live in their own maps (prefixes b"k" and
//!   b"s") so the v4 `Invoice` struct stays byte-identical.
//!   A milestone payout moves funds step by step (one recipient per
//!   transfer, chained through `on_payout_callback`, H-02): a failed
//!   step leaves the remaining steps queued for retry instead of
//!   double-paying the recipients that already got paid.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
};

/// One-time storage deposit for a direct `create_invoice` (H-06).
/// 0.01 NEAR ≈ 3–5x the ~0.002–0.003 NEAR an invoice entry locks.
/// Non-refundable: the ledger entry is permanent bookkeeping history.
const STORAGE_DEPOSIT_YOCTO: u128 = 10_000_000_000_000_000_000_000;
/// Max open (Pending) invoices per seller (H-06).
const MAX_PENDING_PER_SELLER: u64 = 50;
/// Max sellers on a spend-guard allowlist (L-12).
const MAX_ALLOWLIST: usize = 50;
/// Minimum available balance (liquid balance minus escrow) the contract
/// keeps in reserve; new invoices are refused below it (H-06).
const MIN_AVAILABLE_RESERVE_YOCTO: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
/// Nanoseconds in one day (for due dates and the daily spend cap).
const NS_PER_DAY: u64 = 86_400_000_000_000;
/// Gas attached to the escrow-transfer callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Inspection window after a milestone is submitted (v5): if the
/// client stays silent for this long, the seller may claim the
/// milestone with `claim_milestone`. 14 days in nanoseconds. NEAR
/// contracts cannot self-execute, so the claim is a manual call —
/// the same pattern as `claim_refund` after the due date.
const MILESTONE_INSPECTION_NS: u64 = 14 * NS_PER_DAY;
/// Max milestones per invoice (v5).
const MAX_MILESTONES: usize = 5;
/// Max split recipients per invoice (v5).
const MAX_SPLITS: usize = 3;
/// Minimum yoctoNEAR per split share on a single release (v5).
///
/// Derivation: NEAR charges 10^19 yocto (0.01 NEAR) per kilobyte of
/// storage, and a bare account record occupies ~182 bytes, so
/// creating a brand-new recipient account costs ~182 * 10^19 =
/// 1.82 * 10^21 yocto (0.00182 NEAR). A transfer below that to an
/// account that does not exist yet fails, which would strand the
/// whole release. The minimum is rounded up to 0.002 NEAR
/// (2 * 10^21 yocto) for margin, and it is enforced on EVERY share
/// of EVERY release (each milestone amount when milestones exist,
/// otherwise the full invoice amount).
const MIN_SPLIT_SHARE_YOCTO: u128 = 2_000_000_000_000_000_000_000;
/// Max bytes of a milestone description (v5, mirrors line items).
const MAX_MILESTONE_DESC_BYTES: usize = 200;
/// Max bytes of a request-changes reason (v5, mirrors dispute reasons).
const MAX_CHANGE_REASON_BYTES: usize = 200;

/// Invoice lifecycle. The frontend renders these as
/// Pending / Paid / Refunded / Cancelled.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Refunded,
    /// Cancelled by the seller while still Pending (no funds moved).
    Cancelled,
}

/// Currency of an invoice (v2). Serializes to JSON as "Near" | "Usdc".
/// Near amounts are yoctoNEAR; Usdc amounts are micro-USDC (6 decimals).
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum Currency {
    Near,
    Usdc,
}

/// One priced line of a multi-line invoice (v2).
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct InvoiceLineItem {
    /// Max 200 bytes.
    pub description: String,
    /// 1..=10000.
    pub quantity: u32,
    /// Price per unit, in the invoice currency's smallest unit.
    pub unit_price: U128,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Invoice {
    pub id: u64,
    pub seller: AccountId,
    pub client: AccountId,
    /// TOTAL amount (subtotal + tax) in the invoice currency's smallest
    /// unit: yoctoNEAR for `Currency::Near`, micro-USDC for
    /// `Currency::Usdc`.
    pub amount: U128,
    pub description: String,
    pub status: InvoiceStatus,
    /// True once escrowed funds were released to the seller.
    pub released: bool,
    pub created_at: u64,
    pub paid_at: Option<u64>,
    /// Reference for off-chain settlement (1Click deposit address or tx
    /// hash). `None` for plain NEAR escrow payments.
    pub external_ref: Option<String>,
    /// Nanosecond block timestamp by which the seller must release
    /// (or refund). `None` = no deadline, chosen explicitly by the
    /// seller at creation (the pay page warns the client about this).
    pub due_date: Option<u64>,
    /// True while the client disputes a paid, unreleased invoice.
    /// While true, `release_invoice` is blocked.
    pub disputed: bool,
    /// Dispute reason (max 200 bytes), `None` when undisputed.
    pub dispute_reason: Option<String>,
    // ---- v2 fields (appended AFTER all v1 fields; Borsh layout of the
    // v1 prefix is unchanged, which is what makes `migrate` safe). ----
    /// Invoice currency. Near = yoctoNEAR; Usdc = micro-USDC (6 decimals).
    pub currency: Currency,
    /// Line items. Empty = single-line (legacy) invoice.
    pub items: Vec<InvoiceLineItem>,
    /// Tax rate in basis points, 0..=10000 (10000 = 100%).
    pub tax_rate_bps: u32,
    /// Sum of qty * unit_price over `items` (= `amount` when `items`
    /// is empty).
    pub subtotal: U128,
    /// `subtotal * tax_rate_bps / 10000` (0 when `items` is empty).
    pub tax_amount: U128,
}

/// Lifecycle of one funded milestone (v5). The frontend renders these
/// as Pending / Submitted / ChangesRequested / Released.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum MilestoneState {
    Pending,
    Submitted,
    ChangesRequested,
    Released,
}

/// One funded milestone of an invoice (v5). Stored per invoice in the
/// `milestones` map (prefix b"k"), NOT inside `Invoice`: the v4
/// `Invoice` struct must stay byte-identical, so milestones live in
/// their own map keyed by invoice id.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Milestone {
    /// Max 200 bytes.
    pub description: String,
    /// This milestone's share of the invoice amount, in the invoice
    /// currency's smallest unit (yoctoNEAR; milestones are NEAR-only).
    pub amount: U128,
    pub state: MilestoneState,
    /// Block timestamp of the current submission; `None` while the
    /// milestone is not awaiting review. The 14-day inspection window
    /// for `claim_milestone` runs from here.
    pub submitted_at: Option<u64>,
    /// Last reason the client gave with `request_changes`; `None`
    /// unless the milestone is currently ChangesRequested.
    pub change_reason: Option<String>,
}

/// A milestone as passed at invoice creation (v5): description +
/// amount. State is always Pending at creation. Milestone amounts
/// must sum exactly to the invoice amount.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct MilestoneInput {
    pub description: String,
    pub amount: U128,
}

/// One split recipient as passed at invoice creation (v5). `account`
/// is a plain String (not AccountId) so creation can reject an empty
/// or malformed account with a clear panic instead of failing JSON
/// deserialization; it is parsed and stored as an AccountId.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SplitShareInput {
    pub account: String,
    /// Share in basis points, 1..=10000. All shares must sum to
    /// exactly 10000 (100%).
    pub share_bps: u16,
}

/// One split recipient, stored per invoice in the `splits` map
/// (prefix b"s"). Shares sum to exactly 10000.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SplitShare {
    pub account: AccountId,
    pub share_bps: u16,
}

/// One computed share of a single release amount (v5, internal):
/// the account and the exact yoctoNEAR it receives.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, Eq)]
pub struct PayoutShare {
    pub account: AccountId,
    pub amount: U128,
}

/// One transfer inside an in-flight v5 payout (internal). A payout is
/// a flat queue of steps: one step per (milestone, recipient) pair, so
/// a milestone release with splits and a full-invoice release of
/// several milestones are both just a list of transfers executed in
/// order. `milestone_index` is `Some` for a milestone-release step
/// and `None` for a refund step (a refund moves the unreleased
/// portion to the client and releases no milestone).
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, Eq)]
pub struct PayoutStep {
    pub recipient: AccountId,
    pub amount: U128,
    pub milestone_index: Option<u32>,
}

/// An in-flight v5 payout (internal), stored in the `pending_payouts`
/// map (prefix b"n") keyed by invoice id. Only one payout per invoice
/// may be in flight at a time (guarded by `pending_transfers`, the
/// same guard the legacy whole-invoice transfers use).
///
/// `next_step` is the index of the next step that has NOT been paid
/// yet. It only advances on a successful transfer, so after a failed
/// step a retry resumes exactly at the failed recipient instead of
/// double-paying the ones that already got paid. `total` is the whole
/// payout amount, subtracted from `total_escrowed` once the last step
/// succeeds. `is_refund` selects the finalisation: refund (invoice
/// becomes Refunded) versus release (the stepped milestones become
/// Released, and the invoice becomes released once no milestone is
/// left unreleased).
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingPayout {
    pub steps: Vec<PayoutStep>,
    pub next_step: u32,
    pub total: U128,
    pub is_refund: bool,
}

/// Rule-based spend-guard policy, set by an account for itself.
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq,
)]
#[serde(crate = "near_sdk::serde")]
pub struct Policy {
    /// Max amount (yoctoNEAR) a single invoice may charge this account.
    /// 0 = no limit.
    pub max_amount: U128,
    /// Sellers allowed to charge this account. Empty = any seller allowed.
    pub allowed_sellers: Vec<AccountId>,
    /// Total maximum payable via escrow per UTC calendar day.
    /// 0 = no limit.
    pub max_total_per_day: U128,
    /// Amount already paid via escrow on `daily_spent_day`.
    /// Internal accounting, not a setting — `set_policy` preserves it.
    pub daily_spent: U128,
    /// Day number (`block_timestamp_ns / NS_PER_DAY`) that `daily_spent`
    /// belongs to.
    pub daily_spent_day: u64,
}

/// USDC spend-guard policy (v4), set by an account for itself. Same
/// shape and semantics as `Policy`, but denominated in micro-USDC
/// (6 decimals) and enforced for USDC invoices: `max_amount` at
/// creation, `max_total_per_day` at `confirm_external_payment`
/// (the on-chain "payment" event for USDC, mirroring the NEAR daily
/// cap check in `pay_invoice`).
///
/// WHY A SEPARATE MAP (v4 design decision): `Policy` values are
/// stored under prefix b"p" in a `LookupMap`, which has no key
/// enumeration on-chain — a migration could never rewrite the
/// already-stored v3 `Policy` values. Extending the `Policy` struct
/// would make v4 code unable to read any pre-existing v3 policy
/// (Borsh missing-bytes error on read → panic on every
/// create/pay for that client). Keeping `Policy` byte-identical
/// means every existing policy keeps working untouched; the USDC
/// caps live in their own map under prefix b"u", and the v3→v4
/// migration only adds that (initially empty) map.
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq,
)]
#[serde(crate = "near_sdk::serde")]
pub struct UsdcPolicy {
    /// Max amount (micro-USDC) a single USDC invoice may charge this
    /// account. 0 = no limit.
    pub max_amount: U128,
    /// Total maximum confirmable via `confirm_external_payment` per
    /// UTC calendar day. 0 = no limit.
    pub max_total_per_day: U128,
    /// Amount already confirmed via `confirm_external_payment` on
    /// `daily_spent_day`. Internal accounting, not a setting —
    /// `set_policy` preserves it.
    pub daily_spent: U128,
    /// Day number (`block_timestamp_ns / NS_PER_DAY`) that
    /// `daily_spent` belongs to.
    pub daily_spent_day: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    next_invoice_id: u64,
    invoices: LookupMap<u64, Invoice>,
    policies: LookupMap<AccountId, Policy>,
    /// USDC spend-guard policies (v4), one per account, mirroring
    /// `policies` but in micro-USDC. Kept in its own map so the v3
    /// `Policy` values stay byte-identical (see `UsdcPolicy`).
    usdc_policies: LookupMap<AccountId, UsdcPolicy>,
    /// Trusted relayer account for gasless meta-transactions.
    /// `None` = meta-transactions disabled.
    relayer: Option<AccountId>,
    /// Last accepted meta-tx nonce per seller (replay protection).
    meta_nonces: LookupMap<AccountId, u64>,
    /// Invoice ids with an escrow transfer currently in flight
    /// (release, refund, or client claim-refund). `true` = release to
    /// the seller, `false` = refund to the client. Set before the
    /// transfer, cleared by the callback (H-02).
    pending_transfers: LookupMap<u64, bool>,
    /// Invoice ids whose escrow transfer demonstrably failed (the
    /// callback saw a failed promise). Only these may be rescued by
    /// the owner (H-02). Same direction encoding as `pending_transfers`.
    failed_transfers: LookupMap<u64, bool>,
    /// Open (Pending) invoice count per seller, for the H-06 cap.
    open_pending_count: LookupMap<AccountId, u64>,
    /// Total yoctoNEAR currently held in escrow (H-06 accounting).
    total_escrowed: u128,
    /// Two-step owner transfer (H-05): account proposed by the owner,
    /// accepted by the proposed account via `accept_owner`.
    pending_owner: Option<AccountId>,
    /// Funded milestones per invoice (v5), one entry per invoice
    /// created with milestones. Separate map (prefix b"k") so the v4
    /// `Invoice` stays byte-identical.
    milestones: LookupMap<u64, Vec<Milestone>>,
    /// Programmable split recipients per invoice (v5), one entry per
    /// invoice created with splits. Separate map (prefix b"s").
    splits: LookupMap<u64, Vec<SplitShare>>,
    /// In-flight v5 payout (milestone release, multi-milestone
    /// release, or partial refund), one per invoice at a time.
    /// Separate map (prefix b"n"); see `start_payout` /
    /// `on_payout_callback`.
    pending_payouts: LookupMap<u64, PendingPayout>,
}

/// v4 top-level contract state, field order and `LookupMap` prefixes
/// copied exactly from the deployed v4 (invoices b"i", policies b"p",
/// usdc_policies b"u", meta_nonces b"m", pending_transfers b"t",
/// failed_transfers b"f", open_pending_count b"o"). Used ONLY by
/// `migrate` (v4→v5). The v5 `Contract` appends exactly three fields
/// — `milestones` (b"k"), `splits` (b"s"), `pending_payouts` (b"n")
/// — so a v4 state blob is a strict Borsh prefix of a v5 one, but
/// Borsh rejects trailing bytes, which is what makes a second
/// `migrate` panic instead of silently re-running. The v4 `Invoice`,
/// `Policy` and `UsdcPolicy` structs are unchanged in v5, so every
/// stored invoice and policy moves over untouched; only the three new
/// (initially empty) maps are added.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldContractV4 {
    owner: AccountId,
    next_invoice_id: u64,
    invoices: LookupMap<u64, Invoice>,
    policies: LookupMap<AccountId, Policy>,
    usdc_policies: LookupMap<AccountId, UsdcPolicy>,
    relayer: Option<AccountId>,
    meta_nonces: LookupMap<AccountId, u64>,
    pending_transfers: LookupMap<u64, bool>,
    failed_transfers: LookupMap<u64, bool>,
    open_pending_count: LookupMap<AccountId, u64>,
    total_escrowed: u128,
    pending_owner: Option<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        // H-05: init may only run inside the atomic deploy transaction
        // (DeployContract + init in one transaction, signed by the
        // contract account itself). A front-runner calling `new`
        // directly has a different predecessor and is rejected, so the
        // owner can never be stolen in the gap between deploy and init.
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "init must be called by the contract account itself (deploy + init in one transaction)"
        );
        Self {
            owner,
            next_invoice_id: 1,
            invoices: LookupMap::new(b"i"),
            policies: LookupMap::new(b"p"),
            usdc_policies: LookupMap::new(b"u"),
            relayer: None,
            meta_nonces: LookupMap::new(b"m"),
            pending_transfers: LookupMap::new(b"t"),
            failed_transfers: LookupMap::new(b"f"),
            open_pending_count: LookupMap::new(b"o"),
            total_escrowed: 0,
            pending_owner: None,
            milestones: LookupMap::new(b"k"),
            splits: LookupMap::new(b"s"),
            pending_payouts: LookupMap::new(b"n"),
        }
    }

    /// Upgrade the contract state from v4 to v5. The ONLY upgrade
    /// path. Owner only. Reads the v4 state and moves every map and
    /// scalar over untouched — invoices, NEAR policies, USDC policies,
    /// meta nonces, pending/failed transfers, open counts, escrow
    /// total, relayer, pending owner — under the same storage
    /// prefixes. The v4 `Invoice`, `Policy` and `UsdcPolicy` structs
    /// are unchanged in v5, so no value is rewritten; the only change
    /// is the three new, initially empty maps: `milestones`
    /// (prefix b"k"), `splits` (b"s") and `pending_payouts` (b"n").
    ///
    /// After migrating, NEVER call `new` again on a redeploy — `new`
    /// would wipe the state. A second `migrate` panics (a v5 state
    /// blob no longer deserializes as `OldContractV4`: Borsh rejects
    /// the trailing bytes of the appended fields) and leaves the
    /// state untouched.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldContractV4 =
            env::state_read().expect("contract state v4 not found — nothing to migrate");
        assert_eq!(
            env::predecessor_account_id(),
            old.owner,
            "only the owner can migrate"
        );
        Self {
            owner: old.owner,
            next_invoice_id: old.next_invoice_id,
            invoices: old.invoices,
            policies: old.policies,
            usdc_policies: old.usdc_policies,
            relayer: old.relayer,
            meta_nonces: old.meta_nonces,
            pending_transfers: old.pending_transfers,
            failed_transfers: old.failed_transfers,
            open_pending_count: old.open_pending_count,
            total_escrowed: old.total_escrowed,
            pending_owner: old.pending_owner,
            milestones: LookupMap::new(b"k"),
            splits: LookupMap::new(b"s"),
            pending_payouts: LookupMap::new(b"n"),
        }
    }

    /// Shared invoice-creation logic: validates line items / tax,
    /// enforces the client's spend-guard policy, then stores the
    /// invoice. `seller` is the account the invoice is created for.
    /// `require_deposit` is true for the direct path (H-06 storage
    /// deposit) and false for the gasless meta path (the seller cannot
    /// attach a deposit through a signed message).
    ///
    /// Line items (v2): `items` empty means a single-line (legacy)
    /// invoice — then `tax_rate_bps` must be 0, `subtotal == amount`
    /// and `tax_amount == 0`. Otherwise `subtotal` / `tax_amount` are
    /// computed from the items and `amount` must equal their sum.
    /// `currency == Usdc` means `amount` is in micro-USDC: the
    /// NEAR-denominated spend-guard `max_amount` (yoctoNEAR) cannot
    /// apply to a different unit, so the NEAR cap is skipped for
    /// USDC — but the USDC cap (`usdc_max_amount`, v4, micro-USDC)
    /// applies instead, and the allowlist check applies regardless
    /// of currency. The 0.01 NEAR storage deposit still applies: it
    /// pays for storage, not for the invoice value.
    ///
    /// Milestones and splits (v5) are NEAR-only: USDC invoices never
    /// touch escrow (they settle via 1Click straight to the seller),
    /// so there is no on-chain release to split and no milestone to
    /// fund — both must be empty for a USDC invoice.
    fn create_invoice_inner(
        &mut self,
        seller: AccountId,
        client: AccountId,
        amount: U128,
        description: String,
        due_days: Option<u32>,
        require_deposit: bool,
        currency: Currency,
        items: Vec<InvoiceLineItem>,
        tax_rate_bps: u32,
        milestones: Vec<MilestoneInput>,
        splits: Vec<SplitShareInput>,
    ) -> u64 {
        assert!(amount.0 > 0, "amount must be greater than zero");
        assert_ne!(seller, client, "seller cannot invoice themselves");
        assert!(
            description.len() <= 500,
            "description must be at most 500 bytes"
        );

        // v2: validate line items and tax, compute subtotal / tax.
        assert!(items.len() <= 20, "at most 20 line items");
        assert!(tax_rate_bps <= 10_000, "tax_rate_bps must be at most 10000");
        for item in &items {
            assert!(
                item.description.len() <= 200,
                "line item description must be at most 200 bytes"
            );
            assert!(
                (1..=10_000).contains(&item.quantity),
                "line item quantity must be between 1 and 10000"
            );
            assert!(
                item.unit_price.0 > 0,
                "line item unit_price must be greater than zero"
            );
        }
        let (subtotal, tax_amount) = if items.is_empty() {
            assert_eq!(
                tax_rate_bps, 0,
                "tax_rate_bps must be 0 for single-line invoices"
            );
            (amount, U128(0))
        } else {
            let mut subtotal: u128 = 0;
            for item in &items {
                let line = (item.quantity as u128)
                    .checked_mul(item.unit_price.0)
                    .unwrap_or_else(|| env::panic_str("line item total overflow"));
                subtotal = subtotal
                    .checked_add(line)
                    .unwrap_or_else(|| env::panic_str("line item total overflow"));
            }
            let tax_amount = subtotal
                .checked_mul(tax_rate_bps as u128)
                .unwrap_or_else(|| env::panic_str("line item total overflow"))
                / 10_000;
            let total = subtotal
                .checked_add(tax_amount)
                .unwrap_or_else(|| env::panic_str("line item total overflow"));
            assert_eq!(
                amount.0, total,
                "amount must equal line-item total (subtotal + tax)"
            );
            (U128(subtotal), U128(tax_amount))
        };

        // v5: validate milestones and splits (NEAR only). USDC
        // invoices settle off-chain, so neither applies to them.
        if currency != Currency::Near {
            assert!(
                milestones.is_empty(),
                "milestones are only supported for NEAR invoices"
            );
            assert!(
                splits.is_empty(),
                "splits are only supported for NEAR invoices"
            );
        }
        validate_milestones(&milestones, amount.0);
        let parsed_splits = validate_splits(&splits, &milestones, amount.0);

        // H-06: direct creation pays for its permanent ledger entry.
        if require_deposit {
            assert!(
                env::attached_deposit().as_yoctonear() >= STORAGE_DEPOSIT_YOCTO,
                "creating an invoice locks a 0.01 NEAR storage deposit (one-time, non-refundable)"
            );
        }

        // H-06: at most 50 open invoices per seller.
        let open = self.open_pending_count.get(&seller).copied().unwrap_or(0);
        assert!(
            open < MAX_PENDING_PER_SELLER,
            "seller already has 50 open invoices"
        );

        // H-06: never let new invoices eat the reserve that escrow
        // releases/refunds depend on.
        //
        // N-1: `account_balance()` is the account's TOTAL balance — it
        // includes the storage-staked (locked) portion, which can
        // never be spent on a transfer. Once the ~193 KB wasm is
        // deployed, ~1.9 NEAR of the balance is locked for code
        // storage, so measuring against the total would overstate
        // spendable funds by ~1.9 NEAR and let the reserve guard pass
        // while the contract is effectively broke. Subtract
        // `account_locked_balance()` first: the guard is
        // liquid − escrow ≥ 0.1 NEAR, where
        // liquid = total − locked.
        let available = env::account_balance()
            .as_yoctonear()
            .saturating_sub(env::account_locked_balance().as_yoctonear())
            .saturating_sub(self.total_escrowed);
        assert!(
            available >= MIN_AVAILABLE_RESERVE_YOCTO,
            "contract balance too low to create invoices (escrow reserve)"
        );

        if let Some(policy) = self.policies.get(&client) {
            // A USDC amount is micro-USDC, not yoctoNEAR, so the
            // NEAR-denominated max_amount cap cannot apply to it.
            // The allowlist still applies regardless of currency.
            if currency == Currency::Near && policy.max_amount.0 > 0 {
                assert!(
                    amount.0 <= policy.max_amount.0,
                    "amount exceeds client spend-guard limit"
                );
            }
            if !policy.allowed_sellers.is_empty() {
                assert!(
                    policy.allowed_sellers.contains(&seller),
                    "seller is not on the client allowlist"
                );
            }
        }
        // v4: USDC invoices have their own per-invoice cap, in
        // micro-USDC (the NEAR cap above is in yoctoNEAR and cannot
        // apply). The USDC daily cap is enforced at confirmation
        // time in `confirm_external_payment`, mirroring the NEAR
        // daily cap at `pay_invoice` time.
        if currency == Currency::Usdc {
            if let Some(usdc) = self.usdc_policies.get(&client) {
                if usdc.max_amount.0 > 0 {
                    assert!(
                        amount.0 <= usdc.max_amount.0,
                        "amount exceeds client USDC spend-guard limit"
                    );
                }
            }
        }

        let created_at = env::block_timestamp();
        let due_date = match due_days {
            None => None,
            Some(days) => {
                assert!(
                    (1..=90).contains(&days),
                    "due_days must be between 1 and 90, or omitted for no deadline"
                );
                Some(created_at.saturating_add(days as u64 * NS_PER_DAY))
            }
        };

        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let invoice = Invoice {
            id,
            seller: seller.clone(),
            client,
            amount,
            description,
            status: InvoiceStatus::Pending,
            released: false,
            created_at,
            paid_at: None,
            external_ref: None,
            due_date,
            disputed: false,
            dispute_reason: None,
            currency,
            items,
            tax_rate_bps,
            subtotal,
            tax_amount,
        };
        self.invoices.insert(id, invoice);
        self.open_pending_count.insert(seller, open + 1);
        // v5: milestones and splits live in their own maps (the
        // `Invoice` struct stays byte-identical). Empty plans store
        // nothing: `get_milestones` / `get_splits` return empty vecs.
        if !milestones.is_empty() {
            self.milestones.insert(
                id,
                milestones
                    .iter()
                    .map(|m| Milestone {
                        description: m.description.clone(),
                        amount: m.amount,
                        state: MilestoneState::Pending,
                        submitted_at: None,
                        change_reason: None,
                    })
                    .collect(),
            );
        }
        if !parsed_splits.is_empty() {
            self.splits.insert(id, parsed_splits);
        }
        id
    }

    /// Create an invoice for `client`. The caller is the seller.
    /// Enforces the client's spend-guard policy, if one is set.
    /// Requires a 0.01 NEAR storage deposit (H-06, one-time,
    /// non-refundable — it pays for the permanent ledger entry).
    /// `due_days`: 1–90 days until the payment deadline, or `None`
    /// for no deadline (the pay page warns the client about that).
    /// `currency`: `Near` (amount in yoctoNEAR) or `Usdc` (amount in
    /// micro-USDC; USDC invoices settle via 1Click, not escrow — see
    /// `pay_invoice` — and enforce the USDC spend-guard caps
    /// (`usdc_max_amount` at creation, `usdc_daily_cap` at
    /// `confirm_external_payment`), while the allowlist still applies).
    /// `items`: line items (max 20); empty = single-line invoice,
    /// which requires `tax_rate_bps == 0`. With items, `amount` must
    /// equal subtotal + tax computed from the items.
    /// `milestones` (v5, NEAR only): at most 5 funded milestones;
    /// empty = plain invoice. Milestone amounts must sum exactly to
    /// `amount`. The client pays the full amount into escrow up
    /// front; each milestone is released on client approval
    /// (`approve_milestone`) or seller claim after the 14-day
    /// inspection window (`claim_milestone`).
    /// `splits` (v5, NEAR only): at most 3 recipients, shares summing
    /// to exactly 10000 bps; empty = 100% to the seller. Every
    /// milestone release and every full-invoice release distributes
    /// the released amount by the splits.
    #[payable]
    pub fn create_invoice(
        &mut self,
        client: AccountId,
        amount: U128,
        description: String,
        due_days: Option<u32>,
        currency: Currency,
        items: Vec<InvoiceLineItem>,
        tax_rate_bps: u32,
        milestones: Vec<MilestoneInput>,
        splits: Vec<SplitShareInput>,
    ) -> u64 {
        let seller = env::predecessor_account_id();
        self.create_invoice_inner(
            seller,
            client,
            amount,
            description,
            due_days,
            true,
            currency,
            items,
            tax_rate_bps,
            milestones,
            splits,
        )
    }

    /// Verify a seller's NEP-413 ed25519 signature on-chain (M-01).
    /// Reconstructs the exact Borsh payload the wallet signed:
    /// `{ tag: u32 = 2147484061, message, nonce: [u8; 32], recipient,
    /// callbackUrl: None }`, where `message` is the canonical
    /// `twinnear:create_invoice|<seller>|<client>|<amount>|<description>|<counter>|<nonceBase64>|<milestonesJson>|<splitsJson>`.
    /// `<milestonesJson>` is the compact JSON of the milestones array
    /// (e.g. `[]`, or `[{"description":"Design","amount":"500"}]`
    /// with amounts as strings) and `<splitsJson>` the compact JSON
    /// of the splits array (e.g. `[]`, or
    /// `[{"account":"bob.testnet","share_bps":5000}]`), both in field
    /// declaration order, exactly as `serde_json::to_string`
    /// produces them. v5 CHANGE: the two trailing fields are new —
    /// a v4 signature (without them) is rejected, because otherwise
    /// a relayer could attach milestones/splits the seller never
    /// signed for, and a split could redirect the seller's payout.
    /// The signature is over SHA-256 of the serialized payload, not
    /// the raw bytes (Wallet Selector `verifySignature`, per NEP-413).
    /// CORRECTED 2026-11-07: the tag and the hash were both missing,
    /// which made every real Meteor signature fail verification live.
    fn verify_meta_signature(
        seller: &AccountId,
        client: &AccountId,
        amount: U128,
        description: &str,
        nonce: u64,
        nep413_nonce_b64: &str,
        signature_b64: &str,
        public_key_str: &str,
        milestones: &[MilestoneInput],
        splits: &[SplitShareInput],
    ) {
        use near_sdk::base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let nonce_bytes = B64
            .decode(nep413_nonce_b64)
            .unwrap_or_else(|_| env::panic_str("invalid nep413_nonce: not base64"));
        assert_eq!(nonce_bytes.len(), 32, "nep413_nonce must be 32 bytes");
        let sig_bytes = B64
            .decode(signature_b64)
            .unwrap_or_else(|_| env::panic_str("invalid signature: not base64"));
        let sig: &[u8; 64] = sig_bytes
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("invalid signature: must be 64 bytes"));
        let pk_str = public_key_str
            .strip_prefix("ed25519:")
            .unwrap_or_else(|| env::panic_str("public_key must start with ed25519:"));
        let pk_bytes = near_sdk::bs58::decode(pk_str)
            .into_vec()
            .unwrap_or_else(|_| env::panic_str("invalid public_key: not base58"));
        let pk: &[u8; 32] = pk_bytes
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("invalid public_key: must be 32 bytes"));

        let message = format!(
            "twinnear:create_invoice|{}|{}|{}|{}|{}|{}|{}|{}",
            seller,
            client,
            amount.0,
            description,
            nonce,
            nep413_nonce_b64,
            near_sdk::serde_json::to_string(milestones)
                .unwrap_or_else(|_| env::panic_str("milestones are not serializable")),
            near_sdk::serde_json::to_string(splits)
                .unwrap_or_else(|_| env::panic_str("splits are not serializable")),
        );
        let mut payload = Vec::new();
        // NEP-413 tag, hardcoded per the NEP (2^31 + 413). The wallet
        // signs [tag || message || nonce || recipient || callbackUrl];
        // omitting the tag was the cause of the 2026-11-07 live
        // failure ("NEP-413 signature verification failed").
        payload.extend_from_slice(&2147484061u32.to_le_bytes());
        borsh_str(&message, &mut payload);
        payload.extend_from_slice(&nonce_bytes);
        borsh_str(env::current_account_id().as_str(), &mut payload);
        payload.push(0); // callbackUrl: None
                         // The signature is over SHA-256 of the serialized payload,
                         // not the raw bytes (Wallet Selector `verifySignature`).
        let hashed = env::sha256(&payload);
        assert!(
            env::ed25519_verify(sig, &hashed, pk),
            "NEP-413 signature verification failed"
        );
    }

    /// Create an invoice on a seller's behalf, submitted by the trusted
    /// relayer (gasless meta-transaction).
    ///
    /// Trust model: only the relayer account (set by the owner via
    /// `set_relayer`) may call this. The seller's NEP-413 signature is
    /// verified ON-CHAIN (M-01) over the canonical message, so even a
    /// compromised relayer cannot forge invoices for a seller whose key
    /// it does not hold. Replay protection: `nonce` must be strictly
    /// greater than the last accepted nonce for this seller.
    /// `nep413_nonce` is the base64 32-byte NEP-413 nonce from the
    /// signed payload (NOT the replay counter).
    ///
    /// v5: `milestones` and `splits` are part of the signed message
    /// (see `verify_meta_signature`), so a relayer cannot attach a
    /// milestone plan or a split the seller never agreed to. Meta
    /// invoices are NEAR-only with no line items, as before.
    pub fn create_invoice_meta(
        &mut self,
        seller: AccountId,
        client: AccountId,
        amount: U128,
        description: String,
        nonce: u64,
        signature: String,
        public_key: String,
        nep413_nonce: String,
        due_days: Option<u32>,
        milestones: Vec<MilestoneInput>,
        splits: Vec<SplitShareInput>,
    ) -> u64 {
        let relayer = self
            .relayer
            .clone()
            .unwrap_or_else(|| env::panic_str("no relayer configured"));
        assert_eq!(
            env::predecessor_account_id(),
            relayer,
            "only the relayer can submit meta-transactions"
        );
        let last_nonce = self.meta_nonces.get(&seller).copied().unwrap_or(0);
        assert!(nonce > last_nonce, "meta-transaction nonce already used");
        Self::verify_meta_signature(
            &seller,
            &client,
            amount,
            &description,
            nonce,
            &nep413_nonce,
            &signature,
            &public_key,
            &milestones,
            &splits,
        );
        self.meta_nonces.insert(seller.clone(), nonce);
        env::log_str(&format!(
            "meta invoice: seller={} nonce={} public_key={} signature={}",
            seller, nonce, public_key, signature
        ));
        self.create_invoice_inner(
            seller,
            client,
            amount,
            description,
            due_days,
            false,
            Currency::Near,
            vec![],
            0,
            milestones,
            splits,
        )
    }

    /// Set (or clear) the trusted relayer account. Owner only.
    /// Pass `None` to disable meta-transactions.
    pub fn set_relayer(&mut self, relayer: Option<AccountId>) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only the owner can set the relayer"
        );
        self.relayer = relayer;
    }

    /// Propose a new owner (H-05, step 1 of a two-step transfer).
    /// Owner only. The proposed account must accept via `accept_owner`.
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only the owner can propose a new owner"
        );
        assert_ne!(new_owner, self.owner, "new owner must differ");
        self.pending_owner = Some(new_owner);
    }

    /// Accept a proposed owner transfer (H-05, step 2). Only the
    /// proposed account can call this.
    pub fn accept_owner(&mut self) {
        let proposed = self
            .pending_owner
            .clone()
            .unwrap_or_else(|| env::panic_str("no owner transfer proposed"));
        assert_eq!(
            env::predecessor_account_id(),
            proposed,
            "only the proposed owner can accept"
        );
        self.owner = proposed;
        self.pending_owner = None;
    }

    /// Confirm an off-chain settlement (e.g. a client paid from another
    /// chain via 1Click/Intents and the funds landed directly with the
    /// seller). Seller only, invoice must be Pending. `reference` is the
    /// 1Click deposit address (0x + 40 hex) or origin-chain tx hash
    /// (0x + 64 hex), recorded on the invoice for audit. The seller
    /// attests they received the funds; there is no escrow for external
    /// settlements. This is a unilateral attestation — the UI labels it
    /// "Paid · external (unverified)" and it is NOT covered by the
    /// spend-guard and NOT counted toward the daily cap (M-02/M-03).
    ///
    /// v4: for USDC invoices, the client's USDC spend-guard IS
    /// enforced here — the allowlist and the per-invoice cap are
    /// re-checked as they stand now (M-03: the policy in force NOW
    /// governs, not the one at creation), and the USDC daily cap is
    /// enforced with day rollover and accounting, mirroring the NEAR
    /// daily cap in `pay_invoice`. The receipt itself is still
    /// attested, not verified on-chain.
    pub fn confirm_external_payment(&mut self, id: u64, reference: String) {
        let caller = env::predecessor_account_id();
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(
            caller, invoice.seller,
            "only the seller can confirm external payment"
        );
        assert_eq!(
            invoice.status,
            InvoiceStatus::Pending,
            "invoice is not pending"
        );
        assert!(
            is_valid_external_ref(&reference),
            "reference must be a 0x deposit address (42 chars) or tx hash (66 chars)"
        );
        // v4: USDC spend-guard at confirmation time (the on-chain
        // "payment" event for USDC). NEAR invoices confirmed here
        // keep the pre-v4 behaviour (attested, no policy re-check).
        if invoice.currency == Currency::Usdc {
            self.check_usdc_policy_for_confirmation(&invoice);
        }
        invoice.status = InvoiceStatus::Paid;
        invoice.released = true;
        invoice.paid_at = Some(env::block_timestamp());
        invoice.external_ref = Some(reference);
        self.invoices.insert(id, invoice.clone());
        self.decrement_open_count(&invoice.seller);
    }

    /// Re-check the client's CURRENT USDC spend-guard policy at
    /// confirmation time (v4, M-03 for USDC): allowlist + per-invoice
    /// cap as they stand now, plus the daily total cap. Accounts the
    /// confirmed amount into `usdc_daily_spent` (with day rollover)
    /// and persists it. Only called for USDC invoices.
    fn check_usdc_policy_for_confirmation(&mut self, invoice: &Invoice) {
        if let Some(policy) = self.policies.get(&invoice.client) {
            if !policy.allowed_sellers.is_empty() {
                assert!(
                    policy.allowed_sellers.contains(&invoice.seller),
                    "seller is not on the client allowlist"
                );
            }
        }
        if let Some(mut usdc) = self.usdc_policies.get(&invoice.client).cloned() {
            if usdc.max_amount.0 > 0 {
                assert!(
                    invoice.amount.0 <= usdc.max_amount.0,
                    "amount exceeds client USDC spend-guard limit"
                );
            }
            // Daily cap: reset when the UTC day rolls over, then enforce.
            let day = env::block_timestamp() / NS_PER_DAY;
            if day != usdc.daily_spent_day {
                usdc.daily_spent = U128(0);
                usdc.daily_spent_day = day;
            }
            if usdc.max_total_per_day.0 > 0 {
                assert!(
                    usdc.daily_spent
                        .0
                        .checked_add(invoice.amount.0)
                        .map(|total| total <= usdc.max_total_per_day.0)
                        .unwrap_or(false),
                    "payment exceeds client USDC daily total cap"
                );
            }
            usdc.daily_spent = U128(usdc.daily_spent.0 + invoice.amount.0);
            self.usdc_policies.insert(invoice.client.clone(), usdc);
        }
    }

    /// Re-check the client's CURRENT spend-guard policy at payment time
    /// (M-03): max per invoice + allowlist as they stand now, plus the
    /// daily total cap. Returns the (possibly reset) policy so the
    /// caller can persist the updated daily accounting.
    fn check_policy_for_payment(
        &self,
        client: &AccountId,
        seller: &AccountId,
        amount: u128,
    ) -> Option<Policy> {
        let mut policy = self.policies.get(client).cloned()?;
        if policy.max_amount.0 > 0 {
            assert!(
                amount <= policy.max_amount.0,
                "amount exceeds client spend-guard limit"
            );
        }
        if !policy.allowed_sellers.is_empty() {
            assert!(
                policy.allowed_sellers.contains(seller),
                "seller is not on the client allowlist"
            );
        }
        // Daily cap: reset when the UTC day rolls over, then enforce.
        let day = env::block_timestamp() / NS_PER_DAY;
        if day != policy.daily_spent_day {
            policy.daily_spent = U128(0);
            policy.daily_spent_day = day;
        }
        if policy.max_total_per_day.0 > 0 {
            assert!(
                policy
                    .daily_spent
                    .0
                    .checked_add(amount)
                    .map(|total| total <= policy.max_total_per_day.0)
                    .unwrap_or(false),
                "payment exceeds client daily total cap"
            );
        }
        Some(policy)
    }

    /// Pay an invoice. The caller must be the invoice's client and must
    /// attach exactly the invoice amount. Funds stay in escrow in this
    /// contract until `release_invoice`, `refund_invoice`, or the
    /// client's own `claim_refund` after the due date.
    ///
    /// USDC invoices cannot be paid here: the contract holds no USDC.
    /// They settle via 1Click straight to the seller, who then closes
    /// the invoice with `confirm_external_payment`.
    #[payable]
    pub fn pay_invoice(&mut self, id: u64) {
        let payer = env::predecessor_account_id();
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert!(
            invoice.currency == Currency::Near,
            "USDC invoices settle via 1Click, not escrow — seller confirms with confirm_external_payment"
        );
        assert_eq!(
            invoice.status,
            InvoiceStatus::Pending,
            "invoice is not pending"
        );
        assert_eq!(payer, invoice.client, "only the invoice client can pay");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            invoice.amount.0,
            "attached deposit must equal the invoice amount"
        );
        // M-03: the policy in force NOW governs the payment, not the
        // policy that existed when the invoice was created.
        if let Some(mut policy) =
            self.check_policy_for_payment(&invoice.client, &invoice.seller, invoice.amount.0)
        {
            policy.daily_spent = U128(policy.daily_spent.0 + invoice.amount.0);
            self.policies.insert(invoice.client.clone(), policy);
        }
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at = Some(env::block_timestamp());
        self.invoices.insert(id, invoice.clone());
        self.total_escrowed = self.total_escrowed.saturating_add(invoice.amount.0);
        self.decrement_open_count(&invoice.seller);
    }

    /// Decrement a seller's open (Pending) invoice count, saturating.
    fn decrement_open_count(&mut self, seller: &AccountId) {
        let open = self.open_pending_count.get(seller).copied().unwrap_or(0);
        self.open_pending_count
            .insert(seller.clone(), open.saturating_sub(1));
    }

    // ---- v5: funded milestones and programmable splits ----

    /// Load an invoice's milestones (empty vec when the invoice has
    /// none — plain invoices store nothing).
    fn get_milestones_inner(&self, id: u64) -> Vec<Milestone> {
        self.milestones.get(&id).cloned().unwrap_or_default()
    }

    /// Amount already released from an invoice via milestones.
    fn released_milestone_total(&self, id: u64) -> u128 {
        self.get_milestones_inner(id)
            .iter()
            .filter(|m| m.state == MilestoneState::Released)
            .map(|m| m.amount.0)
            .sum()
    }

    /// Still-escrowed (unreleased) portion of an invoice: the full
    /// amount minus released milestones. For a plain invoice this is
    /// the full amount.
    fn unreleased_amount(&self, invoice: &Invoice) -> u128 {
        invoice
            .amount
            .0
            .saturating_sub(self.released_milestone_total(invoice.id))
    }

    /// True when an invoice has a v5 plan — milestones, splits, or
    /// both — so its releases/refunds must go through the payout
    /// path instead of the legacy whole-invoice transfer.
    fn has_v5_plan(&self, id: u64) -> bool {
        !self.get_milestones_inner(id).is_empty()
            || self.splits.get(&id).map(|s| !s.is_empty()).unwrap_or(false)
    }

    /// Split a release amount by the invoice's splits (v5). No splits
    /// configured = 100% to the seller. Each share is floored
    /// (`amount * bps / 10000`); the remainder — fewer yocto than
    /// there are recipients — goes to the FIRST recipient, so the
    /// parts always sum exactly to `amount`.
    fn split_release(&self, invoice: &Invoice, amount: u128) -> Vec<PayoutShare> {
        match self.splits.get(&invoice.id) {
            Some(splits) if !splits.is_empty() => {
                let mut shares: Vec<PayoutShare> = splits
                    .iter()
                    .map(|s| PayoutShare {
                        account: s.account.clone(),
                        amount: U128(
                            amount
                                .checked_mul(s.share_bps as u128)
                                .unwrap_or_else(|| env::panic_str("split share amount overflow"))
                                / 10_000,
                        ),
                    })
                    .collect();
                let distributed: u128 = shares.iter().map(|s| s.amount.0).sum();
                if let Some(first) = shares.first_mut() {
                    first.amount = U128(first.amount.0 + amount.saturating_sub(distributed));
                }
                shares
            }
            _ => vec![PayoutShare {
                account: invoice.seller.clone(),
                amount: U128(amount),
            }],
        }
    }

    /// Start a v5 payout (one milestone release, a multi-milestone
    /// release, or a partial refund): record the step queue and the
    /// in-flight guard, then fire the first transfer with the payout
    /// callback chained (H-02). The payout record survives a failed
    /// step so a retry resumes at the failed step instead of
    /// double-paying earlier recipients. `pending_transfers` is the
    /// shared in-flight guard, so the existing checks in
    /// `open_dispute` / `release_invoice` / `refund_invoice` /
    /// `claim_refund` / `approve_milestone` / `claim_milestone`
    /// block concurrent transfers for this invoice with no changes.
    ///
    /// RESUME: if a payout record already exists for this invoice (a
    /// previous step failed), the call resumes THAT payout from its
    /// first unpaid step, whatever operation was just called — the
    /// passed-in steps are ignored. A half-executed payout must
    /// finish before a different payout can start: its released
    /// amounts are already partly paid out, so no other release or
    /// refund can be computed correctly until it completes.
    fn start_payout(
        &mut self,
        invoice_id: u64,
        steps: Vec<PayoutStep>,
        total: u128,
        is_refund: bool,
    ) -> Promise {
        assert!(
            !self.pending_transfers.contains_key(&invoice_id),
            "a transfer for this invoice is already in flight"
        );
        if let Some(payout) = self.pending_payouts.get(&invoice_id).cloned() {
            let step = payout.steps[payout.next_step as usize].clone();
            self.pending_transfers.insert(invoice_id, !payout.is_refund);
            return Promise::new(step.recipient.clone())
                .transfer(NearToken::from_yoctonear(step.amount.0))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_payout_callback(invoice_id),
                );
        }
        assert!(!steps.is_empty(), "payout has no transfers");
        self.pending_payouts.insert(
            invoice_id,
            PendingPayout {
                steps: steps.clone(),
                next_step: 0,
                total: U128(total),
                is_refund,
            },
        );
        // Direction encoding matches `pending_transfers`: true =
        // release (to the seller / split recipients), false = refund
        // (to the client).
        self.pending_transfers.insert(invoice_id, !is_refund);
        let first = &steps[0];
        Promise::new(first.recipient.clone())
            .transfer(NearToken::from_yoctonear(first.amount.0))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout_callback(invoice_id),
            )
    }

    /// Build the payout steps for releasing one milestone (its amount
    /// split by the invoice's splits) and start it.
    fn start_milestone_payout(&mut self, invoice: &Invoice, milestone_index: u32) -> Promise {
        let milestones = self.get_milestones_inner(invoice.id);
        let milestone = &milestones[milestone_index as usize];
        let shares = self.split_release(invoice, milestone.amount.0);
        let steps: Vec<PayoutStep> = shares
            .into_iter()
            .map(|s| PayoutStep {
                recipient: s.account,
                amount: s.amount,
                milestone_index: Some(milestone_index),
            })
            .collect();
        self.start_payout(invoice.id, steps, milestone.amount.0, false)
    }

    /// Finalise a fully-paid v5 payout: mark the released milestones,
    /// subtract the payout total from escrow, and settle the invoice
    /// (Refunded for a refund; `released = true` once every
    /// milestone is released — a partially released invoice keeps
    /// `released = false` so a dispute, a further release, or a
    /// refund of the remainder all stay possible).
    fn finalize_payout(&mut self, id: u64, payout: &PendingPayout) {
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        if payout.is_refund {
            invoice.status = InvoiceStatus::Refunded;
        } else {
            let mut milestones = self.get_milestones_inner(id);
            for step in &payout.steps {
                if let Some(idx) = step.milestone_index {
                    if let Some(m) = milestones.get_mut(idx as usize) {
                        m.state = MilestoneState::Released;
                    }
                }
            }
            let fully_released = milestones
                .iter()
                .all(|m| m.state == MilestoneState::Released);
            self.milestones.insert(id, milestones);
            if fully_released {
                invoice.released = true;
            }
        }
        self.total_escrowed = self.total_escrowed.saturating_sub(payout.total.0);
        self.invoices.insert(id, invoice);
    }

    /// Submit work for one milestone. Seller only, only while the
    /// invoice is Paid. The milestone must be Pending or
    /// ChangesRequested (a resubmission after the client asked for
    /// changes); a Submitted or Released milestone cannot be
    /// submitted again. Submitting (re)starts the 14-day inspection
    /// window from now and clears any previous change reason.
    /// Allowed during a dispute: it moves no funds, and the client
    /// still has to approve (or stay silent for 14 days) before
    /// anything is released.
    pub fn submit_work(&mut self, invoice_id: u64, milestone_index: u32) {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&invoice_id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can submit work");
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        let mut milestones = self.get_milestones_inner(invoice_id);
        let milestone = milestones
            .get_mut(milestone_index as usize)
            .unwrap_or_else(|| env::panic_str("milestone not found"));
        assert!(
            milestone.state == MilestoneState::Pending
                || milestone.state == MilestoneState::ChangesRequested,
            "only a pending or changes-requested milestone can be submitted"
        );
        milestone.state = MilestoneState::Submitted;
        milestone.submitted_at = Some(env::block_timestamp());
        milestone.change_reason = None;
        self.milestones.insert(invoice_id, milestones);
    }

    /// Approve one submitted milestone. Client only, only while the
    /// invoice is Paid and undisputed. Approval RELEASES the funds
    /// immediately: the milestone amount is paid out at once,
    /// distributed by the invoice's splits (or 100% to the seller
    /// when no splits are configured). There is no separate
    /// approve-then-release step. The milestone is only marked
    /// Released by the payout callback, once every transfer in the
    /// payout succeeds (H-02); a failed step leaves the payout
    /// queued for retry.
    pub fn approve_milestone(&mut self, invoice_id: u64, milestone_index: u32) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&invoice_id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(
            caller, invoice.client,
            "only the client can approve a milestone"
        );
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.disputed, "invoice is disputed, approval blocked");
        let milestones = self.get_milestones_inner(invoice_id);
        let milestone = milestones
            .get(milestone_index as usize)
            .unwrap_or_else(|| env::panic_str("milestone not found"));
        assert_eq!(
            milestone.state,
            MilestoneState::Submitted,
            "only a submitted milestone can be approved"
        );
        self.start_milestone_payout(&invoice, milestone_index)
    }

    /// Ask for changes on a submitted milestone. Client only, only
    /// while the invoice is Paid. The milestone goes back to
    /// ChangesRequested with the reason recorded; the seller
    /// resubmits with `submit_work`, which restarts the inspection
    /// window. Allowed during a dispute (it moves no funds).
    pub fn request_changes(&mut self, invoice_id: u64, milestone_index: u32, reason: String) {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&invoice_id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(
            caller, invoice.client,
            "only the client can request changes"
        );
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!reason.trim().is_empty(), "change reason must not be empty");
        assert!(
            reason.len() <= MAX_CHANGE_REASON_BYTES,
            "change reason must be at most 200 bytes"
        );
        let mut milestones = self.get_milestones_inner(invoice_id);
        let milestone = milestones
            .get_mut(milestone_index as usize)
            .unwrap_or_else(|| env::panic_str("milestone not found"));
        assert_eq!(
            milestone.state,
            MilestoneState::Submitted,
            "only a submitted milestone can be sent back for changes"
        );
        milestone.state = MilestoneState::ChangesRequested;
        milestone.change_reason = Some(reason);
        milestone.submitted_at = None;
        self.milestones.insert(invoice_id, milestones);
    }

    /// Claim a submitted milestone as the seller after the client
    /// stayed silent for the 14-day inspection window
    /// (`MILESTONE_INSPECTION_NS`) from submission. Seller only,
    /// only while the invoice is Paid and undisputed. This is the
    /// seller's exit when the client disappears — the same manual,
    /// no-self-execution pattern as `claim_refund` (a NEAR contract
    /// cannot wake itself up). The payout is identical to an
    /// approval: the milestone amount is released at once,
    /// distributed by the splits.
    pub fn claim_milestone(&mut self, invoice_id: u64, milestone_index: u32) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&invoice_id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(
            caller, invoice.seller,
            "only the seller can claim a milestone"
        );
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.disputed, "invoice is disputed, claim blocked");
        let milestones = self.get_milestones_inner(invoice_id);
        let milestone = milestones
            .get(milestone_index as usize)
            .unwrap_or_else(|| env::panic_str("milestone not found"));
        assert_eq!(
            milestone.state,
            MilestoneState::Submitted,
            "only a submitted milestone can be claimed"
        );
        let submitted_at = milestone
            .submitted_at
            .unwrap_or_else(|| env::panic_str("milestone was never submitted"));
        assert!(
            env::block_timestamp() >= submitted_at.saturating_add(MILESTONE_INSPECTION_NS),
            "inspection window has not passed yet"
        );
        self.start_milestone_payout(&invoice, milestone_index)
    }

    /// Callback for v5 payouts (H-02, same pattern as
    /// `on_transfer_callback`, but step-by-step). Private: only the
    /// contract itself may call it. On transfer success, advance to
    /// the next recipient; when the last step succeeds, finalise the
    /// payout (milestones Released / invoice Refunded, escrow
    /// debited). On failure, the payout record is KEPT — `next_step`
    /// still points at the failed recipient — and only the in-flight
    /// guard is cleared, so a retry pays only the recipients that
    /// have not been paid yet. No `failed_transfers` entry is
    /// written: `rescue_escrow` is a whole-invoice last resort and
    /// cannot express a partial payout; the persisted payout record
    /// IS the retry state for a failed milestone payout.
    #[private]
    pub fn on_payout_callback(&mut self, id: u64) {
        assert_eq!(
            env::promise_results_count(),
            1,
            "expected exactly one promise result"
        );
        let mut payout = self
            .pending_payouts
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no payout in flight for this invoice"));
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                payout.next_step += 1;
                if (payout.next_step as usize) < payout.steps.len() {
                    // More recipients to pay: fire the next transfer
                    // and chain this callback again. The in-flight
                    // guard stays set until the last step succeeds
                    // or one fails.
                    let step = payout.steps[payout.next_step as usize].clone();
                    self.pending_payouts.insert(id, payout);
                    Promise::new(step.recipient.clone())
                        .transfer(NearToken::from_yoctonear(step.amount.0))
                        .then(
                            ext_self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_payout_callback(id),
                        )
                        .detach();
                } else {
                    // All steps paid: finalise.
                    self.pending_payouts.remove(&id);
                    self.pending_transfers.remove(&id);
                    self.finalize_payout(id, &payout);
                }
            }
            PromiseResult::Failed => {
                self.pending_transfers.remove(&id);
                env::log_str(&format!(
                    "milestone payout failed for invoice {} at step {}; retry the release to resume from the unpaid recipient",
                    id, payout.next_step
                ));
            }
        }
    }

    /// Cancel an invoice. Seller only, only while Pending (no funds
    /// have moved). Settles typo'd invoices instead of leaving them
    /// as permanent ledger litter (H-03).
    pub fn cancel_invoice(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can cancel");
        assert_eq!(
            invoice.status,
            InvoiceStatus::Pending,
            "only a pending invoice can be cancelled"
        );
        invoice.status = InvoiceStatus::Cancelled;
        self.invoices.insert(id, invoice.clone());
        self.decrement_open_count(&invoice.seller);
    }

    /// Open a dispute on a paid, unreleased invoice. Client only.
    /// While disputed, `release_invoice` is blocked; the seller can
    /// still refund at any time (H-03).
    ///
    /// N-3: refused while an escrow transfer for this invoice is in
    /// flight — otherwise the dispute could open mid-release and the
    /// transfer callback would still finalise the release, silently
    /// defeating the dispute. N-4: an empty reason is refused.
    pub fn open_dispute(&mut self, id: u64, reason: String) {
        let caller = env::predecessor_account_id();
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.client, "only the client can dispute");
        assert_eq!(
            invoice.status,
            InvoiceStatus::Paid,
            "only a paid invoice can be disputed"
        );
        assert!(!invoice.released, "funds already released");
        assert!(!invoice.disputed, "invoice is already disputed");
        assert!(
            !reason.trim().is_empty(),
            "dispute reason must not be empty"
        );
        assert!(
            reason.len() <= 200,
            "dispute reason must be at most 200 bytes"
        );
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        invoice.disputed = true;
        invoice.dispute_reason = Some(reason);
        self.invoices.insert(id, invoice);
    }

    /// Withdraw a dispute (the parties made peace). Client only.
    /// Release becomes possible again.
    pub fn withdraw_dispute(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        let mut invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.client, "only the client can withdraw");
        assert!(invoice.disputed, "invoice is not disputed");
        invoice.disputed = false;
        invoice.dispute_reason = None;
        self.invoices.insert(id, invoice);
    }

    /// Start an escrow transfer under the H-02 callback pattern:
    /// mark the transfer in flight, then transfer with a callback that
    /// only finalises the invoice when the promise succeeds. `is_release`
    /// selects the direction (true = to seller, false = to client).
    fn start_escrow_transfer(&mut self, invoice: &Invoice, is_release: bool) -> Promise {
        let recipient = if is_release {
            invoice.seller.clone()
        } else {
            invoice.client.clone()
        };
        self.pending_transfers.insert(invoice.id, is_release);
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(invoice.amount.0))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_callback(invoice.id),
            )
    }

    /// Release escrowed funds to the seller. Only the seller, only while
    /// the invoice is Paid and not yet released, and not while disputed.
    /// The invoice is marked released only by the callback, once the
    /// transfer promise succeeds (H-02). If the transfer fails, the
    /// release can simply be retried.
    ///
    /// v5: for an invoice WITH milestones, `release_invoice` releases
    /// ALL remaining unreleased milestones at once — every milestone
    /// that is not yet Released, whatever its state (Pending,
    /// Submitted, or ChangesRequested), each distributed by the
    /// splits — and marks the invoice released. For an invoice with
    /// splits but no milestones, the full amount is distributed by
    /// the splits. This is the seller's existing whole-invoice
    /// release right, kept whole: per-milestone client control lives
    /// in `approve_milestone` / `request_changes` /
    /// `claim_milestone`, and a dispute still blocks this call
    /// entirely. For a plain invoice (no milestones, no splits) the
    /// behaviour is unchanged (one transfer of the full amount to
    /// the seller, legacy path).
    pub fn release_invoice(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can release");
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.released, "funds already released");
        assert!(!invoice.disputed, "invoice is disputed — release blocked");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        if self.has_v5_plan(id) {
            let milestones = self.get_milestones_inner(id);
            if milestones.is_empty() {
                // Splits without milestones: one release of the full
                // amount, distributed by the splits.
                let steps: Vec<PayoutStep> = self
                    .split_release(&invoice, invoice.amount.0)
                    .into_iter()
                    .map(|s| PayoutStep {
                        recipient: s.account,
                        amount: s.amount,
                        milestone_index: None,
                    })
                    .collect();
                return self.start_payout(id, steps, invoice.amount.0, false);
            }
            let mut steps: Vec<PayoutStep> = Vec::new();
            let mut total: u128 = 0;
            for (idx, m) in milestones.iter().enumerate() {
                if m.state == MilestoneState::Released {
                    continue;
                }
                for share in self.split_release(&invoice, m.amount.0) {
                    steps.push(PayoutStep {
                        recipient: share.account,
                        amount: share.amount,
                        milestone_index: Some(idx as u32),
                    });
                }
                total = total.saturating_add(m.amount.0);
            }
            assert!(!steps.is_empty(), "all milestones already released");
            return self.start_payout(id, steps, total, false);
        }
        self.start_escrow_transfer(&invoice, true)
    }

    /// Refund the client. Only the seller, only while the invoice is Paid
    /// and funds are still escrowed (not released). Works even while
    /// disputed — a cooperative seller can always return the money.
    /// Finalised by the callback on transfer success (H-02).
    ///
    /// v5: for an invoice WITH milestones, only the UNRELEASED portion
    /// is refunded (invoice amount minus released milestones);
    /// already-released milestones stay released.
    pub fn refund_invoice(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can refund");
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.released, "funds already released");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        if self.has_v5_plan(id) {
            let unreleased = self.unreleased_amount(&invoice);
            assert!(unreleased > 0, "no unreleased funds to refund");
            let steps = vec![PayoutStep {
                recipient: invoice.client.clone(),
                amount: U128(unreleased),
                milestone_index: None,
            }];
            return self.start_payout(id, steps, unreleased, true);
        }
        self.start_escrow_transfer(&invoice, false)
    }

    /// Claim a refund as the client, after the invoice's due date has
    /// passed (H-03). This is the client's exit when the seller goes
    /// silent. Uses the same callback pattern as release/refund (H-02):
    /// the invoice is only marked Refunded once the transfer succeeds.
    ///
    /// v5: for an invoice WITH milestones, only the UNRELEASED portion
    /// is claimed; already-released milestones stay released.
    pub fn claim_refund(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.client, "only the client can claim");
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.released, "funds already released");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        let due = invoice.due_date.unwrap_or_else(|| {
            env::panic_str("invoice has no due date — claim_refund needs a deadline")
        });
        assert!(env::block_timestamp() >= due, "due date has not passed yet");
        if self.has_v5_plan(id) {
            let unreleased = self.unreleased_amount(&invoice);
            assert!(unreleased > 0, "no unreleased funds to refund");
            let steps = vec![PayoutStep {
                recipient: invoice.client.clone(),
                amount: U128(unreleased),
                milestone_index: None,
            }];
            return self.start_payout(id, steps, unreleased, true);
        }
        self.start_escrow_transfer(&invoice, false)
    }

    /// Callback for escrow transfers (H-02). Private: only the contract
    /// itself may call it. On transfer success, finalises the invoice
    /// (release → `released = true`; refund/claim → `Refunded`) and
    /// releases the escrow accounting. On failure, records the failure
    /// so the seller/client can retry — or the owner can rescue it.
    #[private]
    pub fn on_transfer_callback(&mut self, id: u64) {
        assert_eq!(
            env::promise_results_count(),
            1,
            "expected exactly one promise result"
        );
        let is_release = self
            .pending_transfers
            .get(&id)
            .copied()
            .unwrap_or_else(|| env::panic_str("no transfer in flight for this invoice"));
        self.pending_transfers.remove(&id);
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                let mut invoice = self
                    .invoices
                    .get(&id)
                    .unwrap_or_else(|| env::panic_str("invoice not found"))
                    .clone();
                if is_release {
                    invoice.released = true;
                } else {
                    invoice.status = InvoiceStatus::Refunded;
                }
                self.total_escrowed = self.total_escrowed.saturating_sub(invoice.amount.0);
                self.invoices.insert(id, invoice);
            }
            PromiseResult::Failed => {
                self.failed_transfers.insert(id, is_release);
                env::log_str(&format!(
                    "escrow transfer failed for invoice {} (release={}); retry release/refund, or owner rescue",
                    id, is_release
                ));
            }
        }
    }

    /// Rescue escrow whose transfer demonstrably failed (H-02, last
    /// resort). Owner only, only for invoices recorded in
    /// `failed_transfers`. Sends the escrowed amount to `to` (e.g. a
    /// fresh account when the original recipient's account was deleted)
    /// and finalises the invoice the same way the callback would.
    /// Whole-invoice transfers only: v5 milestone payouts never write
    /// `failed_transfers` — a failed payout step is retried from its
    /// persisted payout record (`on_payout_callback`), which a rescue
    /// could not express.
    pub fn rescue_escrow(&mut self, id: u64, to: AccountId) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only the owner can rescue stuck escrow"
        );
        let is_release = self
            .failed_transfers
            .get(&id)
            .copied()
            .unwrap_or_else(|| env::panic_str("no failed transfer recorded for this invoice"));
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(invoice.status, InvoiceStatus::Paid, "invoice is not paid");
        assert!(!invoice.released, "funds already released");
        self.failed_transfers.remove(&id);
        // Finalisation happens in the callback (which reads the
        // direction from `pending_transfers`); record the rescue
        // destination in the log for audit.
        env::log_str(&format!(
            "rescue escrow: invoice {} -> {} (release={})",
            id, to, is_release
        ));
        let amount = invoice.amount.0;
        self.pending_transfers.insert(id, is_release);
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_callback(id),
            )
    }

    /// Set (or replace) the caller's own spend-guard policy.
    /// `max_total_per_day` caps escrow payments per UTC day (0 = no
    /// limit). Editing the settings NEVER resets the daily accounting:
    /// `daily_spent` / `daily_spent_day` are carried over from the
    /// existing policy (M-03). The allowlist is capped at 50 entries
    /// and deduplicated (L-12).
    ///
    /// v4: `usdc_max_amount` (micro-USDC per USDC invoice, 0 = no
    /// limit) and `usdc_daily_cap` (micro-USDC confirmable per UTC
    /// day, 0 = no limit) set the USDC caps in the same call; the
    /// USDC daily accounting is carried over the same way.
    pub fn set_policy(
        &mut self,
        max_amount: U128,
        allowed_sellers: Vec<AccountId>,
        max_total_per_day: U128,
        usdc_max_amount: U128,
        usdc_daily_cap: U128,
    ) {
        assert!(
            allowed_sellers.len() <= MAX_ALLOWLIST,
            "allowlist must have at most 50 sellers"
        );
        let mut deduped: Vec<AccountId> = Vec::new();
        for seller in allowed_sellers {
            if !deduped.contains(&seller) {
                deduped.push(seller);
            }
        }
        let account = env::predecessor_account_id();
        let existing = self.policies.get(&account).cloned().unwrap_or_default();
        self.policies.insert(
            account.clone(),
            Policy {
                max_amount,
                allowed_sellers: deduped,
                max_total_per_day,
                daily_spent: existing.daily_spent,
                daily_spent_day: existing.daily_spent_day,
            },
        );
        let existing_usdc = self
            .usdc_policies
            .get(&account)
            .cloned()
            .unwrap_or_default();
        self.usdc_policies.insert(
            account,
            UsdcPolicy {
                max_amount: usdc_max_amount,
                max_total_per_day: usdc_daily_cap,
                daily_spent: existing_usdc.daily_spent,
                daily_spent_day: existing_usdc.daily_spent_day,
            },
        );
    }

    // ---- Views ----

    /// Schema version of this contract. v1 had no such method;
    /// v2 returns 2. v3 fixes the NEP-413 verification (tag + SHA-256);
    /// state schema is unchanged from v2, so a v2 -> v3 redeploy needs
    /// NO migrate call. v4 adds the USDC spend-guard caps
    /// (`UsdcPolicy` map, prefix b"u"); a v3 -> v4 redeploy NEEDS
    /// `migrate` (the top-level state gains one field). v5 adds
    /// funded milestones (`milestones` map, prefix b"k"),
    /// programmable splits (`splits` map, prefix b"s") and the
    /// in-flight payout record (`pending_payouts`, prefix b"n"); a
    /// v4 -> v5 redeploy NEEDS `migrate` (the top-level state gains
    /// three fields).
    pub fn get_version(&self) -> u32 {
        5
    }

    /// Funded milestones of an invoice (v5), in creation order.
    /// Empty vec = the invoice has no milestones (plain invoice).
    /// Each entry: `{"description": "...", "amount": "500",
    /// "state": "Pending" | "Submitted" | "ChangesRequested" |
    /// "Released", "submitted_at": null | <ns timestamp>,
    /// "change_reason": null | "..."}`.
    pub fn get_milestones(&self, invoice_id: u64) -> Vec<Milestone> {
        self.milestones
            .get(&invoice_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Programmable split recipients of an invoice (v5), in creation
    /// order. Empty vec = no splits configured (100% to the seller).
    /// Each entry: `{"account": "bob.testnet", "share_bps": 5000}`.
    /// Shares sum to exactly 10000.
    pub fn get_splits(&self, invoice_id: u64) -> Vec<SplitShare> {
        self.splits.get(&invoice_id).cloned().unwrap_or_default()
    }

    pub fn get_invoice(&self, id: u64) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn list_invoices(&self, from_index: u64, limit: u64) -> Vec<Invoice> {
        let mut out = Vec::new();
        let end = core::cmp::min(from_index.saturating_add(limit), self.next_invoice_id);
        let mut i = from_index.max(1);
        while i < end {
            if let Some(inv) = self.invoices.get(&i) {
                out.push(inv.clone());
            }
            i += 1;
        }
        out
    }

    pub fn get_policy(&self, account_id: AccountId) -> Option<Policy> {
        self.policies.get(&account_id).cloned()
    }

    /// USDC spend-guard policy of an account (v4), if one is set.
    /// `None` = no USDC caps (any USDC amount allowed, allowlist
    /// from the NEAR policy still applies).
    pub fn get_usdc_policy(&self, account_id: AccountId) -> Option<UsdcPolicy> {
        self.usdc_policies.get(&account_id).cloned()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_relayer(&self) -> Option<AccountId> {
        self.relayer.clone()
    }

    pub fn get_meta_nonce(&self, account_id: AccountId) -> u64 {
        self.meta_nonces.get(&account_id).copied().unwrap_or(0)
    }

    pub fn get_invoice_count(&self) -> u64 {
        self.next_invoice_id.saturating_sub(1)
    }

    /// Open (Pending) invoice count for a seller (H-06 cap visibility).
    pub fn get_open_invoice_count(&self, account_id: AccountId) -> u64 {
        self.open_pending_count
            .get(&account_id)
            .copied()
            .unwrap_or(0)
    }

    /// Total yoctoNEAR currently held in escrow (H-06 accounting).
    pub fn get_total_escrowed(&self) -> U128 {
        U128(self.total_escrowed)
    }

    /// Account proposed as the next owner, if an owner transfer is
    /// pending (H-05).
    pub fn get_pending_owner(&self) -> Option<AccountId> {
        self.pending_owner.clone()
    }
}

/// Callback trait for escrow transfers (H-02). The generated
/// `ext_self::ext(...)` builder creates the cross-contract call back
/// into this contract.
#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_transfer_callback(&mut self, id: u64);
    fn on_payout_callback(&mut self, id: u64);
}

/// Borsh-encode a string (u32 little-endian length + UTF-8 bytes).
fn borsh_str(s: &str, out: &mut Vec<u8>) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// Accept a 1Click deposit address (`0x` + 40 hex chars) or an
/// origin-chain tx hash (`0x` + 64 hex chars) as an external reference.
fn is_valid_external_ref(reference: &str) -> bool {
    let bytes = reference.as_bytes();
    if bytes.len() != 42 && bytes.len() != 66 {
        return false;
    }
    if !reference.starts_with("0x") {
        return false;
    }
    reference[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validate funded milestones (v5) at creation: at most 5, each with
/// a description of at most 200 bytes and an amount greater than
/// zero, and the amounts must sum exactly to the invoice amount.
/// Empty (no milestones) is always valid — plain invoices keep
/// working exactly as before.
fn validate_milestones(milestones: &[MilestoneInput], invoice_amount: u128) {
    if milestones.is_empty() {
        return;
    }
    assert!(milestones.len() <= MAX_MILESTONES, "at most 5 milestones");
    let mut total: u128 = 0;
    for m in milestones {
        assert!(
            m.description.len() <= MAX_MILESTONE_DESC_BYTES,
            "milestone description must be at most 200 bytes"
        );
        assert!(m.amount.0 > 0, "milestone amount must be greater than zero");
        total = total
            .checked_add(m.amount.0)
            .unwrap_or_else(|| env::panic_str("milestone amounts overflow"));
    }
    assert_eq!(
        total, invoice_amount,
        "milestone amounts must sum to the invoice amount"
    );
}

/// Validate programmable splits (v5) at creation and return the
/// parsed recipients: at most 3, no duplicate or empty/invalid
/// account, every share 1..=10000, shares summing to exactly 10000,
/// and every share of every release at least
/// `MIN_SPLIT_SHARE_YOCTO` (a release is one milestone amount when
/// milestones exist, otherwise the full invoice amount — that is the
/// amount each split is actually paid from). Empty (no splits) is
/// always valid and means 100% to the seller.
fn validate_splits(
    splits: &[SplitShareInput],
    milestones: &[MilestoneInput],
    invoice_amount: u128,
) -> Vec<SplitShare> {
    if splits.is_empty() {
        return Vec::new();
    }
    assert!(splits.len() <= MAX_SPLITS, "at most 3 split recipients");
    let mut parsed: Vec<SplitShare> = Vec::new();
    let mut total_bps: u32 = 0;
    for s in splits {
        assert!(
            !s.account.trim().is_empty(),
            "split recipient account must not be empty"
        );
        let account: AccountId = s.account.parse().unwrap_or_else(|_| {
            env::panic_str("split recipient account is not a valid account id")
        });
        assert!(s.share_bps > 0, "split share must be greater than zero");
        assert!(s.share_bps <= 10_000, "split share must be at most 10000");
        assert!(
            !parsed.iter().any(|p: &SplitShare| p.account == account),
            "split recipients must be unique"
        );
        total_bps += s.share_bps as u32;
        parsed.push(SplitShare {
            account,
            share_bps: s.share_bps,
        });
    }
    assert_eq!(total_bps, 10_000, "split shares must sum to 10000 (100%)");
    // Minimum per share, checked against every amount a release can
    // actually pay from (each milestone, or the whole invoice).
    let release_amounts: Vec<u128> = if milestones.is_empty() {
        vec![invoice_amount]
    } else {
        milestones.iter().map(|m| m.amount.0).collect()
    };
    for amount in release_amounts {
        for s in &parsed {
            let share = amount
                .checked_mul(s.share_bps as u128)
                .unwrap_or_else(|| env::panic_str("split share amount overflow"))
                / 10_000;
            assert!(
                share >= MIN_SPLIT_SHARE_YOCTO,
                "split share below minimum: every share of every release must be at least 0.002 NEAR"
            );
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::testing_env;

    const STORAGE_DEPOSIT: u128 = STORAGE_DEPOSIT_YOCTO;
    const ONE_DAY_NS: u64 = NS_PER_DAY;

    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.testnet".parse().unwrap()
    }
    fn carol() -> AccountId {
        "carol.testnet".parse().unwrap()
    }
    fn relayer_acct() -> AccountId {
        "relayer.testnet".parse().unwrap()
    }
    fn contract_acct() -> AccountId {
        "twinnear.testnet".parse().unwrap()
    }

    /// init (H-05) may only be called by the contract account itself,
    /// so setup() inits as twinnear.testnet, then switches to the
    /// acting account. Every context carries the 0.01 NEAR storage
    /// deposit so direct `create_invoice` calls succeed.
    fn setup(predecessor: AccountId) -> Contract {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(contract_acct())
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT))
            .build();
        testing_env!(ctx);
        let c = Contract::new(contract_acct());
        set_predecessor(predecessor);
        c
    }

    fn set_predecessor(predecessor: AccountId) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT))
            .build();
        testing_env!(ctx);
    }

    fn set_predecessor_no_deposit(predecessor: AccountId) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .current_account_id(contract_acct())
            .build();
        testing_env!(ctx);
    }

    fn set_predecessor_with_deposit(predecessor: AccountId, deposit_yocto: u128) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .build();
        testing_env!(ctx);
    }

    fn set_time(predecessor: AccountId, timestamp_ns: u64) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT))
            .block_timestamp(timestamp_ns)
            .build();
        testing_env!(ctx);
    }

    /// Rebuild the context with an explicit contract balance and
    /// locked (storage-staked) balance (N-1 tests). The storage
    /// deposit is kept so direct `create_invoice` calls still pass
    /// the deposit check.
    fn set_context_with_balance(predecessor: AccountId, balance_yocto: u128, locked_yocto: u128) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT))
            .account_balance(NearToken::from_yoctonear(balance_yocto))
            .account_locked_balance(NearToken::from_yoctonear(locked_yocto))
            .build();
        testing_env!(ctx);
    }

    /// Run the private transfer callback as the contract itself, with a
    /// mocked promise result.
    fn run_callback(c: &mut Contract, id: u64, result: PromiseResult) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(contract_acct())
            .current_account_id(contract_acct())
            .build();
        testing_env_with_promise_results(ctx, result);
        c.on_transfer_callback(id);
    }

    fn pay_invoice_as(c: &mut Contract, id: u64, payer: AccountId, amount: u128) {
        set_predecessor_with_deposit(payer, amount);
        c.pay_invoice(id);
    }

    /// Like `pay_invoice_as`, but keeps an explicit block timestamp
    /// (the plain helper rebuilds the context at timestamp 0).
    fn pay_invoice_at(
        c: &mut Contract,
        id: u64,
        payer: AccountId,
        amount: u128,
        timestamp_ns: u64,
    ) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(payer)
            .current_account_id(contract_acct())
            .attached_deposit(NearToken::from_yoctonear(amount))
            .block_timestamp(timestamp_ns)
            .build();
        testing_env!(ctx);
        c.pay_invoice(id);
    }

    /// Sign a real NEP-413 payload for a meta invoice (M-01 test helper).
    /// Returns (signature_b64, public_key, nep413_nonce_b64).
    /// Signs the v5 canonical message (with the `|[]|[]` empty
    /// milestones/splits suffix); see `signed_meta_args_with_plan`
    /// for signing a non-empty plan.
    fn signed_meta_args(
        seller: AccountId,
        client: AccountId,
        amount: u128,
        description: &str,
        counter: u64,
    ) -> (String, String, String) {
        signed_meta_args_with_plan(seller, client, amount, description, counter, "[]", "[]")
    }

    /// Sign a real NEP-413 payload for a meta invoice with an explicit
    /// milestone/splits plan (v5 test helper). `milestones_json` /
    /// `splits_json` are the compact JSON arrays exactly as the
    /// contract serializes them, e.g.
    /// `[{"description":"Design","amount":"500"}]` and
    /// `[{"account":"bob.testnet","share_bps":5000}]`.
    fn signed_meta_args_with_plan(
        seller: AccountId,
        client: AccountId,
        amount: u128,
        description: &str,
        counter: u64,
        milestones_json: &str,
        splits_json: &str,
    ) -> (String, String, String) {
        use ed25519_dalek::Signer;
        use near_sdk::base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key();
        let public_key = format!(
            "ed25519:{}",
            near_sdk::bs58::encode(verifying.as_bytes()).into_string()
        );
        let nonce_bytes = [9u8; 32];
        let nonce_b64 = B64.encode(nonce_bytes);
        let message = format!(
            "twinnear:create_invoice|{}|{}|{}|{}|{}|{}|{}|{}",
            seller, client, amount, description, counter, nonce_b64, milestones_json, splits_json
        );
        let mut payload = Vec::new();
        // NEP-413 tag, hardcoded per the NEP (2^31 + 413) - must match
        // verify_meta_signature and the wallet's serializeNep413.
        payload.extend_from_slice(&2147484061u32.to_le_bytes());
        payload.extend_from_slice(&(message.len() as u32).to_le_bytes());
        payload.extend_from_slice(message.as_bytes());
        payload.extend_from_slice(&nonce_bytes);
        let recipient = "twinnear.testnet";
        payload.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        payload.extend_from_slice(recipient.as_bytes());
        payload.push(0);
        // The wallet signs SHA-256 of the serialized payload.
        let hashed = near_sdk::env::sha256(&payload);
        let sig = signing.sign(&hashed);
        (B64.encode(sig.to_bytes()), public_key, nonce_b64)
    }

    #[test]
    fn create_invoice_works() {
        let mut c = setup(alice());
        let id = c.create_invoice(
            bob(),
            U128(1_000),
            "design".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.seller, alice());
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert_eq!(inv.external_ref, None);
        assert_eq!(inv.due_date, Some(14 * ONE_DAY_NS));
        assert!(!inv.disputed);
        assert_eq!(c.get_open_invoice_count(alice()), 1);
    }

    #[test]
    fn create_invoice_no_deadline() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "design".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(c.get_invoice(1).unwrap().due_date, None);
    }

    #[test]
    #[should_panic(expected = "due_days must be between 1 and 90")]
    fn create_invoice_rejects_bad_due_days() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            Some(0),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "due_days must be between 1 and 90")]
    fn create_invoice_rejects_due_days_over_90() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            Some(91),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "0.01 NEAR storage deposit")]
    fn create_invoice_requires_storage_deposit() {
        let mut c = setup(alice());
        set_predecessor_no_deposit(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "seller cannot invoice themselves")]
    fn create_invoice_rejects_self_invoice() {
        let mut c = setup(alice());
        c.create_invoice(
            alice(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "init must be called by the contract account itself")]
    fn init_rejects_non_contract_caller() {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(alice())
            .current_account_id(contract_acct())
            .build();
        testing_env!(ctx);
        Contract::new(contract_acct());
    }

    #[test]
    #[should_panic(expected = "amount exceeds client spend-guard limit")]
    fn policy_max_amount_enforced() {
        let mut c = setup(bob());
        c.set_policy(U128(500), vec![], U128(0), U128(0), U128(0));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "too big".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "seller is not on the client allowlist")]
    fn policy_allowlist_enforced() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![carol()], U128(0), U128(0), U128(0));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(100),
            "not allowed".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    fn policy_allowlist_allows_listed_seller() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![alice()], U128(0), U128(0), U128(0));
        set_predecessor(alice());
        let id = c.create_invoice(
            bob(),
            U128(100),
            "ok".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
    }

    #[test]
    fn set_policy_dedups_allowlist() {
        let mut c = setup(bob());
        c.set_policy(
            U128(0),
            vec![alice(), alice(), carol()],
            U128(0),
            U128(0),
            U128(0),
        );
        let policy = c.get_policy(bob()).unwrap();
        assert_eq!(policy.allowed_sellers, vec![alice(), carol()]);
    }

    #[test]
    #[should_panic(expected = "allowlist must have at most 50 sellers")]
    fn set_policy_rejects_huge_allowlist() {
        let mut c = setup(bob());
        let sellers: Vec<AccountId> = (0..51)
            .map(|i| format!("seller{}.testnet", i).parse().unwrap())
            .collect();
        c.set_policy(U128(0), sellers, U128(0), U128(0), U128(0));
    }

    #[test]
    fn pay_release_flow_with_callback() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Paid);
        assert_eq!(c.get_total_escrowed(), U128(1_000));
        set_predecessor(alice());
        let _promise = c.release_invoice(1);
        // Not released yet: the callback has not run.
        assert!(!c.get_invoice(1).unwrap().released);
        // A second release while the transfer is in flight is rejected.
        let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_invoice(1);
        }));
        assert!(second.is_err());
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert!(c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn refund_callback_failure_allows_retry() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _promise = c.refund_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Failed);
        // Still Paid: the failed transfer did not finalise anything.
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Paid);
        assert!(!inv.released);
        assert_eq!(c.get_total_escrowed(), U128(1_000));
        // Retry works, and a successful callback finalises the refund.
        set_predecessor(alice());
        let _promise = c.refund_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn rescue_after_failed_transfer() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _promise = c.release_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Failed);
        // Only the owner can rescue, and only after a recorded failure.
        set_predecessor(contract_acct());
        let _promise = c.rescue_escrow(1, carol());
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert!(c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    #[should_panic(expected = "no failed transfer recorded")]
    fn rescue_requires_recorded_failure() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(contract_acct());
        let _promise = c.rescue_escrow(1, carol());
    }

    #[test]
    fn cancel_invoice_flow() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "typo".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.cancel_invoice(1);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Cancelled);
        assert_eq!(c.get_open_invoice_count(alice()), 0);
    }

    #[test]
    #[should_panic(expected = "only a pending invoice can be cancelled")]
    fn cancel_paid_invoice_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        c.cancel_invoice(1);
    }

    #[test]
    fn dispute_blocks_release_until_withdrawn() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        c.open_dispute(1, "work not delivered".to_string());
        let inv = c.get_invoice(1).unwrap();
        assert!(inv.disputed);
        assert_eq!(inv.dispute_reason.as_deref(), Some("work not delivered"));
        // Release is blocked while disputed.
        set_predecessor(alice());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_invoice(1);
        }));
        assert!(blocked.is_err());
        // But the seller can still refund during a dispute.
        let _promise = c.refund_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
    }

    #[test]
    fn reserve_guard_counts_only_liquid_balance() {
        // N-1: total balance 0.25 NEAR looks fine, but 0.2 NEAR of it
        // is storage-locked — liquid is only 0.05 NEAR, below the
        // 0.1 NEAR reserve, so creation must be refused. Before the
        // fix the guard measured the total and let this through.
        const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
        let mut c = setup(alice());
        set_context_with_balance(alice(), 25 * NEAR / 100, 20 * NEAR / 100);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "x".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(refused.is_err());
        // Same total, less locked: liquid 0.15 NEAR >= 0.1 reserve.
        set_context_with_balance(alice(), 25 * NEAR / 100, 10 * NEAR / 100);
        let id = c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
    }

    #[test]
    #[should_panic(expected = "dispute reason must not be empty")]
    fn open_dispute_rejects_empty_reason() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        c.open_dispute(1, "   ".to_string());
    }

    #[test]
    fn open_dispute_rejected_while_transfer_in_flight() {
        // N-3: seller starts a release; while the transfer is in
        // flight the client must not be able to open a dispute that
        // the callback would then silently override by finalising
        // the release.
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _promise = c.release_invoice(1);
        set_predecessor(bob());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.open_dispute(1, "too late?".to_string());
        }));
        assert!(blocked.is_err());
        // If the transfer FAILS, the dispute opens normally again.
        run_callback(&mut c, 1, PromiseResult::Failed);
        set_predecessor(bob());
        c.open_dispute(1, "work not delivered".to_string());
        assert!(c.get_invoice(1).unwrap().disputed);
    }

    #[test]
    fn withdraw_dispute_unblocks_release() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        c.open_dispute(1, "late".to_string());
        c.withdraw_dispute(1);
        assert!(!c.get_invoice(1).unwrap().disputed);
        set_predecessor(alice());
        let _promise = c.release_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert!(c.get_invoice(1).unwrap().released);
    }

    #[test]
    fn claim_refund_after_due_date() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        // Seller goes silent; past the due date the client claims.
        set_time(bob(), 15 * ONE_DAY_NS);
        let _promise = c.claim_refund(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    #[should_panic(expected = "due date has not passed yet")]
    fn claim_refund_before_due_date_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_time(bob(), 13 * ONE_DAY_NS);
        let _promise = c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "invoice has no due date")]
    fn claim_refund_without_due_date_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        let _promise = c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "amount exceeds client spend-guard limit")]
    fn pay_rechecks_policy_at_payment_time() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        // Client sets a stricter policy AFTER the invoice was created.
        set_predecessor(bob());
        c.set_policy(U128(500), vec![], U128(0), U128(0), U128(0));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
    }

    #[test]
    fn daily_cap_enforced_and_resets_next_day() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "a".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(1_000),
            "b".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(1_500), U128(0), U128(0));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        // Second 1,000 would exceed the 1,500/day cap.
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pay_invoice_as(&mut c, 2, bob(), 1_000);
        }));
        assert!(over.is_err());
        // Next UTC day the quota resets and the same payment succeeds.
        // (pay_invoice_as would reset the timestamp to 0, so use the
        // timestamp-preserving helper here.)
        pay_invoice_at(&mut c, 2, bob(), 1_000, ONE_DAY_NS);
        assert_eq!(c.get_invoice(2).unwrap().status, InvoiceStatus::Paid);
    }

    #[test]
    fn set_policy_preserves_daily_spent() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "a".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(5_000), U128(0), U128(0));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        // Edit the settings: daily accounting must survive.
        set_predecessor(bob());
        c.set_policy(U128(2_000), vec![], U128(5_000), U128(0), U128(0));
        let policy = c.get_policy(bob()).unwrap();
        assert_eq!(policy.daily_spent, U128(1_000));
        assert_eq!(policy.max_amount, U128(2_000));
    }

    #[test]
    fn pending_invoice_cap_50() {
        let mut c = setup(alice());
        for _ in 0..50 {
            set_predecessor(alice());
            c.create_invoice(
                bob(),
                U128(1_000),
                "x".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }
        assert_eq!(c.get_open_invoice_count(alice()), 50);
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "one too many".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(over.is_err());
        // Cancelling one frees a slot.
        c.cancel_invoice(1);
        let id = c.create_invoice(
            bob(),
            U128(1_000),
            "fits now".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 51);
    }

    #[test]
    #[should_panic(expected = "no relayer configured")]
    fn meta_requires_relayer() {
        let mut c = setup(alice());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "x", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "x".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "only the relayer can submit meta-transactions")]
    fn meta_rejects_non_relayer_caller() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        // Caller is alice, not the relayer.
        set_predecessor(alice());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "x", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "x".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    fn meta_flow_and_nonce_replay() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "gasless", 1);
        let id = c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "gasless".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            Some(14),
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_meta_nonce(alice()), 1);
        assert_eq!(c.get_relayer(), Some(relayer_acct()));
        assert_eq!(c.get_invoice(1).unwrap().due_date, Some(14 * ONE_DAY_NS));
    }

    #[test]
    #[should_panic(expected = "NEP-413 signature verification failed")]
    fn meta_rejects_old_layout_signature() {
        // Regression test for the 2026-11-07 live failure: a signature
        // over the pre-v3 payload layout (no NEP-413 tag, signed over
        // the raw bytes instead of their SHA-256) must be rejected,
        // even though it was valid under the old (wrong) verifier.
        use ed25519_dalek::Signer;
        use near_sdk::base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key();
        let public_key = format!(
            "ed25519:{}",
            near_sdk::bs58::encode(verifying.as_bytes()).into_string()
        );
        let nonce_bytes = [9u8; 32];
        let nonce_b64 = B64.encode(nonce_bytes);
        let message = format!(
            "twinnear:create_invoice|{}|{}|{}|{}|{}|{}",
            alice(),
            bob(),
            100,
            "x",
            1,
            nonce_b64
        );
        // Old (broken) layout: no tag, raw payload signed directly.
        let mut payload = Vec::new();
        payload.extend_from_slice(&(message.len() as u32).to_le_bytes());
        payload.extend_from_slice(message.as_bytes());
        payload.extend_from_slice(&nonce_bytes);
        let recipient = "twinnear.testnet";
        payload.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        payload.extend_from_slice(recipient.as_bytes());
        payload.push(0);
        let sig = signing.sign(&payload);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "x".to_string(),
            1,
            B64.encode(sig.to_bytes()),
            public_key,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "NEP-413 signature verification failed")]
    fn meta_rejects_bad_signature() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        // Signed for a DIFFERENT amount than submitted.
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 999, "gasless", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "gasless".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "meta-transaction nonce already used")]
    fn meta_rejects_reused_nonce() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "a", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "a".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
        // Same nonce again must fail.
        let (sig2, pk2, nonce_b64_2) = signed_meta_args(alice(), bob(), 100, "b", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "b".to_string(),
            1,
            sig2,
            pk2,
            nonce_b64_2,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "only the owner can set the relayer")]
    fn set_relayer_owner_only() {
        let mut c = setup(alice());
        c.set_relayer(Some(relayer_acct()));
    }

    #[test]
    fn owner_transfer_two_step() {
        let mut c = setup(contract_acct());
        c.propose_owner(carol());
        assert_eq!(c.get_pending_owner(), Some(carol()));
        // The current owner cannot accept for the new owner.
        let wrong = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.accept_owner();
        }));
        assert!(wrong.is_err());
        set_predecessor(carol());
        c.accept_owner();
        assert_eq!(c.get_owner(), carol());
        assert_eq!(c.get_pending_owner(), None);
    }

    #[test]
    fn confirm_external_payment_flow() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "cross-chain".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Paid);
        assert!(inv.released);
        assert_eq!(
            inv.external_ref,
            Some("0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string())
        );
        assert!(inv.paid_at.is_some());
        // External settlement holds no escrow.
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    #[should_panic(expected = "reference must be a 0x deposit address")]
    fn confirm_external_payment_rejects_bad_ref() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, "0xabc".to_string());
    }

    #[test]
    #[should_panic(expected = "only the seller can confirm external payment")]
    fn confirm_external_payment_seller_only() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        set_predecessor(bob());
        c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
    }

    // ---- v2: line items, tax, USDC, migration ----

    fn line_item(description: &str, quantity: u32, unit_price: u128) -> InvoiceLineItem {
        InvoiceLineItem {
            description: description.to_string(),
            quantity,
            unit_price: U128(unit_price),
        }
    }

    #[test]
    fn create_invoice_line_items_and_tax() {
        let mut c = setup(alice());
        let items = vec![line_item("Design", 2, 1_000), line_item("Testing", 3, 500)];
        // subtotal = 2*1000 + 3*500 = 3500; tax 10% = 350; total = 3850.
        let id = c.create_invoice(
            bob(),
            U128(3_850),
            "work".to_string(),
            None,
            Currency::Near,
            items,
            1000,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.currency, Currency::Near);
        assert_eq!(inv.items.len(), 2);
        assert_eq!(inv.items[0], line_item("Design", 2, 1_000));
        assert_eq!(inv.tax_rate_bps, 1000);
        assert_eq!(inv.subtotal, U128(3_500));
        assert_eq!(inv.tax_amount, U128(350));
        assert_eq!(inv.amount, U128(3_850));
    }

    #[test]
    fn create_invoice_line_items_tax_rounds_down() {
        let mut c = setup(alice());
        // subtotal 999, tax 5% = 49 (integer division, 49.95 rounds down).
        let id = c.create_invoice(
            bob(),
            U128(1_048),
            "odd".to_string(),
            None,
            Currency::Near,
            vec![line_item("A", 1, 999)],
            500,
            vec![],
            vec![],
        );
        let inv = c.get_invoice(id).unwrap();
        assert_eq!(inv.subtotal, U128(999));
        assert_eq!(inv.tax_amount, U128(49));
        assert_eq!(inv.amount, U128(1_048));
    }

    #[test]
    #[should_panic(expected = "amount must equal line-item total")]
    fn create_invoice_line_items_rejects_wrong_total() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(3_851),
            "work".to_string(),
            None,
            Currency::Near,
            vec![line_item("Design", 2, 1_000)],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "tax_rate_bps must be 0 for single-line invoices")]
    fn create_invoice_single_line_rejects_tax() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "x".to_string(),
            None,
            Currency::Near,
            vec![],
            500,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "line item total overflow")]
    fn create_invoice_line_items_rejects_overflow() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1),
            "x".to_string(),
            None,
            Currency::Near,
            vec![line_item("A", 10_000, u128::MAX)],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    fn create_invoice_usdc_skips_max_amount_but_keeps_allowlist() {
        // Client caps NEAR invoices at 500 yocto and allowlists alice.
        // A USDC invoice of 25.00 USDC (25_000_000 micro-USDC) is far
        // above the NEAR cap, but the NEAR cap is in a different unit
        // and must not apply; the USDC cap (0 here = no limit) and the
        // allowlist still do.
        let mut c = setup(bob());
        c.set_policy(U128(500), vec![alice()], U128(0), U128(0), U128(0));
        set_predecessor(alice());
        let id = c.create_invoice(
            bob(),
            U128(25_000_000),
            "usdc work".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        let inv = c.get_invoice(id).unwrap();
        assert_eq!(inv.currency, Currency::Usdc);
        assert_eq!(inv.subtotal, U128(25_000_000));
        assert_eq!(inv.tax_amount, U128(0));
        assert_eq!(inv.amount, U128(25_000_000));
        // carol is NOT on the allowlist: her USDC invoice is refused.
        set_predecessor(carol());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(25_000_000),
                "nope".to_string(),
                None,
                Currency::Usdc,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(blocked.is_err());
    }

    #[test]
    #[should_panic(expected = "USDC invoices settle via 1Click, not escrow")]
    fn pay_invoice_rejects_usdc() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(25_000_000),
            "usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 25_000_000);
    }

    /// Write the exact v4 state that is live on twinnear.testnet into
    /// mock storage: owner twinnear.testnet, next id 5, four invoices
    /// (#1 TW-2026-0001, 0.05 NEAR, Paid + released, created
    /// 1794021148914561684; #2 retainer 1.01 NEAR Pending; #3
    /// "Testing 2" 0.01 NEAR Pending; #4 "Testing 3" 0.01 NEAR
    /// Pending, client 0xward.testnet, created 1794059451923263766,
    /// due 1795269051923263766), a v4 NEAR policy for 0xward.testnet,
    /// a v4 USDC policy for 0xward.testnet, relayer
    /// twinnear.testnet, meta nonce alice = 3, open pending
    /// count 3 for twinnear.testnet, total_escrowed 0.
    fn write_v4_state_with_live_invoices() {
        let mut invoices: LookupMap<u64, Invoice> = LookupMap::new(b"i");
        invoices.insert(
            1,
            Invoice {
                id: 1,
                seller: contract_acct(),
                client: "0xward.testnet".parse().unwrap(),
                amount: U128(50_000_000_000_000_000_000_000),
                description: "Design work, Framework, Testing".to_string(),
                status: InvoiceStatus::Paid,
                released: true,
                created_at: 1_794_021_148_914_561_684,
                paid_at: Some(1_794_021_148_914_561_684),
                external_ref: None,
                due_date: Some(1_795_230_748_914_561_684),
                disputed: false,
                dispute_reason: None,
                currency: Currency::Near,
                items: vec![],
                tax_rate_bps: 0,
                subtotal: U128(50_000_000_000_000_000_000_000),
                tax_amount: U128(0),
            },
        );
        invoices.insert(
            2,
            Invoice {
                id: 2,
                seller: contract_acct(),
                client: "0xward.testnet".parse().unwrap(),
                amount: U128(1_010_000_000_000_000_000_000_000),
                description: "Retainer".to_string(),
                status: InvoiceStatus::Pending,
                released: false,
                created_at: 1_794_040_000_000_000_000,
                paid_at: None,
                external_ref: None,
                due_date: Some(1_795_000_000_000_000_000),
                disputed: false,
                dispute_reason: None,
                currency: Currency::Near,
                items: vec![],
                tax_rate_bps: 0,
                subtotal: U128(1_010_000_000_000_000_000_000_000),
                tax_amount: U128(0),
            },
        );
        invoices.insert(
            3,
            Invoice {
                id: 3,
                seller: contract_acct(),
                client: "0xward.testnet".parse().unwrap(),
                amount: U128(10_000_000_000_000_000_000_000),
                description: "Testing 2".to_string(),
                status: InvoiceStatus::Pending,
                released: false,
                created_at: 1_794_050_000_000_000_000,
                paid_at: None,
                external_ref: None,
                due_date: Some(1_795_010_000_000_000_000),
                disputed: false,
                dispute_reason: None,
                currency: Currency::Near,
                items: vec![],
                tax_rate_bps: 0,
                subtotal: U128(10_000_000_000_000_000_000_000),
                tax_amount: U128(0),
            },
        );
        invoices.insert(
            4,
            Invoice {
                id: 4,
                seller: contract_acct(),
                client: "0xward.testnet".parse().unwrap(),
                amount: U128(10_000_000_000_000_000_000_000),
                description: "Testing 3".to_string(),
                status: InvoiceStatus::Pending,
                released: false,
                created_at: 1_794_059_451_923_263_766,
                paid_at: None,
                external_ref: None,
                due_date: Some(1_795_269_051_923_263_766),
                disputed: false,
                dispute_reason: None,
                currency: Currency::Near,
                items: vec![],
                tax_rate_bps: 0,
                subtotal: U128(10_000_000_000_000_000_000_000),
                tax_amount: U128(0),
            },
        );
        let mut policies: LookupMap<AccountId, Policy> = LookupMap::new(b"p");
        policies.insert(
            "0xward.testnet".parse().unwrap(),
            Policy {
                max_amount: U128(5_000_000_000_000_000_000_000_000),
                allowed_sellers: vec![contract_acct()],
                max_total_per_day: U128(10_000_000_000_000_000_000_000_000),
                daily_spent: U128(1_000_000_000_000_000_000_000_000),
                daily_spent_day: 20_761,
            },
        );
        let mut meta_nonces: LookupMap<AccountId, u64> = LookupMap::new(b"m");
        meta_nonces.insert(alice(), 3);
        let mut usdc_policies: LookupMap<AccountId, UsdcPolicy> = LookupMap::new(b"u");
        usdc_policies.insert(
            "0xward.testnet".parse().unwrap(),
            UsdcPolicy {
                max_amount: U128(50_000_000),
                max_total_per_day: U128(100_000_000),
                daily_spent: U128(10_000_000),
                daily_spent_day: 20_761,
            },
        );
        let mut open_pending_count: LookupMap<AccountId, u64> = LookupMap::new(b"o");
        open_pending_count.insert(contract_acct(), 3);
        let old = OldContractV4 {
            owner: contract_acct(),
            next_invoice_id: 5,
            invoices,
            policies,
            usdc_policies,
            relayer: Some(contract_acct()),
            meta_nonces,
            pending_transfers: LookupMap::new(b"t"),
            failed_transfers: LookupMap::new(b"f"),
            open_pending_count,
            total_escrowed: 0,
            pending_owner: None,
        };
        env::state_write(&old);
    }

    #[test]
    fn migrate_v4_state_with_live_invoices() {
        set_predecessor(contract_acct());
        write_v4_state_with_live_invoices();
        let mut c = Contract::migrate();
        assert_eq!(c.get_version(), 5);
        assert_eq!(c.get_owner(), contract_acct());
        assert_eq!(c.get_invoice_count(), 4);
        assert_eq!(c.get_relayer(), Some(contract_acct()));
        assert_eq!(c.get_total_escrowed(), U128(0));
        // Invoice #1: live-exact, Paid + released.
        let inv1 = c.get_invoice(1).unwrap();
        assert_eq!(inv1.seller, contract_acct());
        assert_eq!(inv1.client, "0xward.testnet".parse::<AccountId>().unwrap());
        assert_eq!(inv1.amount, U128(50_000_000_000_000_000_000_000));
        assert_eq!(inv1.description, "Design work, Framework, Testing");
        assert_eq!(inv1.status, InvoiceStatus::Paid);
        assert!(inv1.released);
        assert_eq!(inv1.created_at, 1_794_021_148_914_561_684);
        assert_eq!(inv1.currency, Currency::Near);
        // Invoices #2-#4 survive, Pending, unreleased.
        for id in 2..=4 {
            let inv = c.get_invoice(id).unwrap();
            assert_eq!(inv.status, InvoiceStatus::Pending);
            assert!(!inv.released);
        }
        assert_eq!(
            c.get_invoice(2).unwrap().amount,
            U128(1_010_000_000_000_000_000_000_000)
        );
        assert_eq!(c.get_invoice(3).unwrap().description, "Testing 2");
        let inv4 = c.get_invoice(4).unwrap();
        assert_eq!(inv4.description, "Testing 3");
        assert_eq!(inv4.created_at, 1_794_059_451_923_263_766);
        assert_eq!(inv4.due_date, Some(1_795_269_051_923_263_766));
        // The v4 NEAR policy survives byte-identical, including its
        // daily accounting.
        let policy = c.get_policy("0xward.testnet".parse().unwrap()).unwrap();
        assert_eq!(policy.max_amount, U128(5_000_000_000_000_000_000_000_000));
        assert_eq!(policy.allowed_sellers, vec![contract_acct()]);
        assert_eq!(policy.daily_spent, U128(1_000_000_000_000_000_000_000_000));
        assert_eq!(policy.daily_spent_day, 20_761);
        // The v4 USDC policy survives byte-identical too, including
        // its daily accounting.
        let usdc = c
            .get_usdc_policy("0xward.testnet".parse().unwrap())
            .unwrap();
        assert_eq!(usdc.max_amount, U128(50_000_000));
        assert_eq!(usdc.max_total_per_day, U128(100_000_000));
        assert_eq!(usdc.daily_spent, U128(10_000_000));
        assert_eq!(usdc.daily_spent_day, 20_761);
        // The new v5 maps start empty for the migrated invoices.
        assert!(c.get_milestones(1).is_empty());
        assert!(c.get_splits(1).is_empty());
        assert!(c.get_milestones(4).is_empty());
        assert!(c.get_splits(4).is_empty());
        // Meta nonce survives: a replay of nonce 3 must fail, and
        // nonce 4 (the next one) is the live one.
        assert_eq!(c.get_meta_nonce(alice()), 3);
        assert_eq!(c.get_open_invoice_count(contract_acct()), 3);
        // New invoices work after migration (next id is 5): a
        // milestone + splits invoice, then a plain USDC invoice.
        set_predecessor(alice());
        let id = c.create_invoice(
            bob(),
            U128(10_000_000_000_000_000_000_000),
            "post-migrate milestones".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![
                MilestoneInput {
                    description: "part 1".to_string(),
                    amount: U128(6_000_000_000_000_000_000_000),
                },
                MilestoneInput {
                    description: "part 2".to_string(),
                    amount: U128(4_000_000_000_000_000_000_000),
                },
            ],
            vec![SplitShareInput {
                account: carol().to_string(),
                share_bps: 10_000,
            }],
        );
        assert_eq!(id, 5);
        assert_eq!(c.get_invoice_count(), 5);
        assert_eq!(c.get_milestones(5).len(), 2);
        assert_eq!(
            c.get_milestones(5)[0].amount,
            U128(6_000_000_000_000_000_000_000)
        );
        assert_eq!(c.get_milestones(5)[1].state, MilestoneState::Pending);
        assert_eq!(c.get_splits(5).len(), 1);
        assert_eq!(c.get_splits(5)[0].account, carol());
        assert_eq!(c.get_splits(5)[0].share_bps, 10_000);
        let id = c.create_invoice(
            bob(),
            U128(10_000_000),
            "post-migrate usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 6);
        assert_eq!(c.get_invoice_count(), 6);
        set_predecessor(bob());
        c.set_policy(
            U128(0),
            vec![],
            U128(0),
            U128(50_000_000),
            U128(100_000_000),
        );
        let usdc = c.get_usdc_policy(bob()).unwrap();
        assert_eq!(usdc.max_amount, U128(50_000_000));
        assert_eq!(usdc.max_total_per_day, U128(100_000_000));
    }

    #[test]
    #[should_panic(expected = "only the owner can migrate")]
    fn migrate_rejects_non_owner() {
        set_predecessor(alice());
        write_v4_state_with_live_invoices();
        Contract::migrate();
    }

    #[test]
    fn migrate_twice_panics_without_damaging_state() {
        set_predecessor(contract_acct());
        write_v4_state_with_live_invoices();
        let c = Contract::migrate();
        assert_eq!(c.get_version(), 5);
        // End of the first migrate "call": on-chain, the wrapper
        // writes the returned v5 state back to storage. In a unit
        // test that write does not happen automatically — and v5
        // rewrites NO map values, so dropping the contract would
        // flush nothing either. Write the v5 state explicitly,
        // exactly as the on-chain wrapper does.
        env::state_write(&c);
        drop(c);
        // Second migrate must panic: a v5 state blob no longer
        // deserializes as OldContractV4 (Borsh rejects the trailing
        // bytes of the three appended fields).
        let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Contract::migrate();
        }));
        assert!(second.is_err());
        // State undamaged: the contract still reads back from storage
        // with all four invoices intact.
        let c2: Contract = env::state_read().expect("state should still exist");
        assert_eq!(c2.get_version(), 5);
        assert_eq!(c2.get_invoice_count(), 4);
        let inv = c2.get_invoice(1).unwrap();
        assert_eq!(inv.amount, U128(50_000_000_000_000_000_000_000));
        assert_eq!(inv.description, "Design work, Framework, Testing");
        assert_eq!(inv.status, InvoiceStatus::Paid);
        assert_eq!(inv.currency, Currency::Near);
        assert_eq!(c2.get_invoice(4).unwrap().description, "Testing 3");
        assert_eq!(c2.get_owner(), contract_acct());
        assert_eq!(c2.get_relayer(), Some(contract_acct()));
        // The v4 USDC policy survived the round-trip too.
        assert_eq!(
            c2.get_usdc_policy("0xward.testnet".parse().unwrap())
                .unwrap()
                .max_amount,
            U128(50_000_000)
        );
    }

    // ---- v4: adversarial / conformance tests (ala Veto) ----

    #[test]
    #[should_panic(expected = "amount must be greater than zero")]
    fn create_invoice_rejects_zero_amount() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(0),
            "free?".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    fn create_invoice_description_boundary() {
        let mut c = setup(alice());
        // Exactly 500 bytes is accepted.
        let ok = "d".repeat(500);
        let id = c.create_invoice(
            bob(),
            U128(100),
            ok,
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        // 501 bytes is refused.
        let too_long = "d".repeat(501);
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                too_long,
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(rejected.is_err());
    }

    #[test]
    fn create_invoice_twenty_line_items_ok() {
        let mut c = setup(alice());
        let items: Vec<InvoiceLineItem> = (0..20)
            .map(|i| line_item(&format!("item {}", i), 1, 100))
            .collect();
        // 20 x 100 = 2000, no tax.
        let id = c.create_invoice(
            bob(),
            U128(2_000),
            "max items".to_string(),
            None,
            Currency::Near,
            items,
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_invoice(1).unwrap().items.len(), 20);
    }

    #[test]
    #[should_panic(expected = "at most 20 line items")]
    fn create_invoice_twenty_one_line_items_rejected() {
        let mut c = setup(alice());
        let items: Vec<InvoiceLineItem> = (0..21)
            .map(|i| line_item(&format!("item {}", i), 1, 100))
            .collect();
        c.create_invoice(
            bob(),
            U128(2_100),
            "too many".to_string(),
            None,
            Currency::Near,
            items,
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    fn create_invoice_tax_boundaries() {
        let mut c = setup(alice());
        // 100% tax (10000 bps) is the legal maximum.
        let items = vec![line_item("A", 1, 1_000)];
        let id = c.create_invoice(
            bob(),
            U128(2_000),
            "full tax".to_string(),
            None,
            Currency::Near,
            items,
            10_000,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_invoice(1).unwrap().tax_amount, U128(1_000));
        // 10001 bps is refused.
        let items = vec![line_item("A", 1, 1_000)];
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(2_000),
                "over tax".to_string(),
                None,
                Currency::Near,
                items,
                10_001,
                vec![],
                vec![],
            );
        }));
        assert!(rejected.is_err());
    }

    #[test]
    fn create_invoice_line_item_bounds() {
        let mut c = setup(alice());
        // Quantity 0 refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                "q0".to_string(),
                None,
                Currency::Near,
                vec![line_item("A", 0, 100)],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
        // Quantity 10001 refused; 10000 is the max and works.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000_100),
                "q-big".to_string(),
                None,
                Currency::Near,
                vec![line_item("A", 10_001, 100)],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
        let id = c.create_invoice(
            bob(),
            U128(1_000_000),
            "q-max".to_string(),
            None,
            Currency::Near,
            vec![line_item("A", 10_000, 100)],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        // Unit price 0 refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                "p0".to_string(),
                None,
                Currency::Near,
                vec![line_item("A", 1, 0)],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
        // Line-item description 201 bytes refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                "d-long".to_string(),
                None,
                Currency::Near,
                vec![line_item(&"x".repeat(201), 1, 100)],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
    }

    #[test]
    fn create_invoice_due_days_boundaries() {
        let mut c = setup(alice());
        // 1 and 90 days are the legal extremes.
        let id1 = c.create_invoice(
            bob(),
            U128(100),
            "d1".to_string(),
            Some(1),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(c.get_invoice(id1).unwrap().due_date, Some(ONE_DAY_NS));
        let id2 = c.create_invoice(
            bob(),
            U128(100),
            "d90".to_string(),
            Some(90),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(c.get_invoice(id2).unwrap().due_date, Some(90 * ONE_DAY_NS));
        // 0 and 91 are refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                "d0".to_string(),
                Some(0),
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(100),
                "d91".to_string(),
                Some(91),
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }));
        assert!(bad.is_err());
    }

    #[test]
    fn dispute_reason_length_boundary() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "a".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(1_000),
            "b".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        pay_invoice_as(&mut c, 2, bob(), 1_000);
        // Exactly 200 bytes is accepted.
        set_predecessor(bob());
        c.open_dispute(1, "r".repeat(200));
        assert!(c.get_invoice(1).unwrap().disputed);
        // 201 bytes is refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.open_dispute(2, "r".repeat(201));
        }));
        assert!(bad.is_err());
    }

    #[test]
    #[should_panic(expected = "invoice is not pending")]
    fn double_pay_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        pay_invoice_as(&mut c, 1, bob(), 1_000);
    }

    #[test]
    #[should_panic(expected = "attached deposit must equal the invoice amount")]
    fn pay_wrong_amount_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 999);
    }

    #[test]
    #[should_panic(expected = "only the invoice client can pay")]
    fn pay_by_non_client_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, carol(), 1_000);
    }

    #[test]
    #[should_panic(expected = "invoice is not paid")]
    fn release_unpaid_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.release_invoice(1);
    }

    #[test]
    #[should_panic(expected = "invoice is not paid")]
    fn release_after_refund_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _p = c.refund_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        // run_callback leaves the predecessor as the contract itself.
        set_predecessor(alice());
        c.release_invoice(1);
    }

    #[test]
    #[should_panic(expected = "funds already released")]
    fn refund_after_release_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _p = c.release_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert!(c.get_invoice(1).unwrap().released);
        // run_callback leaves the predecessor as the contract itself.
        set_predecessor(alice());
        c.refund_invoice(1);
    }

    #[test]
    #[should_panic(expected = "only a paid invoice can be disputed")]
    fn dispute_unpaid_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        set_predecessor(bob());
        c.open_dispute(1, "too early".to_string());
    }

    #[test]
    #[should_panic(expected = "invoice is already disputed")]
    fn dispute_twice_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        c.open_dispute(1, "first".to_string());
        c.open_dispute(1, "second".to_string());
    }

    #[test]
    #[should_panic(expected = "invoice is not disputed")]
    fn withdraw_dispute_without_dispute_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        c.withdraw_dispute(1);
    }

    #[test]
    #[should_panic(expected = "only the client can claim")]
    fn claim_refund_by_non_client_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_time(carol(), 15 * ONE_DAY_NS);
        c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "funds already released")]
    fn claim_refund_after_release_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        let _p = c.release_invoice(1);
        run_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        set_time(bob(), 15 * ONE_DAY_NS);
        c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "only a pending invoice can be cancelled")]
    fn cancel_twice_rejected() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "work".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.cancel_invoice(1);
        c.cancel_invoice(1);
    }

    #[test]
    fn confirm_external_payment_edges() {
        let mut c = setup(alice());
        // A 66-char tx hash reference is accepted (not just the 42-char
        // deposit address).
        c.create_invoice(
            bob(),
            U128(1_000),
            "hash-ref".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, format!("0x{}", "ab".repeat(32)));
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Paid);
        // Confirming the same invoice twice is refused.
        let twice = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        }));
        assert!(twice.is_err());
        // A cancelled invoice cannot be confirmed either.
        c.create_invoice(
            bob(),
            U128(1_000),
            "cancelled".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.cancel_invoice(2);
        let cancelled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.confirm_external_payment(2, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        }));
        assert!(cancelled.is_err());
    }

    #[test]
    fn meta_nonce_gap_ok() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        // A nonce that skips ahead (gap) is accepted — the contract
        // only requires strictly increasing nonces.
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "gasless", 5);
        let id = c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "gasless".to_string(),
            5,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_meta_nonce(alice()), 5);
        // But a lower (already used) nonce is rejected.
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "gasless", 3);
        let lower = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice_meta(
                alice(),
                bob(),
                U128(100),
                "gasless".to_string(),
                3,
                sig,
                pk,
                nonce_b64,
                None,
                vec![],
                vec![],
            );
        }));
        assert!(lower.is_err());
    }

    #[test]
    #[should_panic(expected = "NEP-413 signature verification failed")]
    fn meta_signature_for_other_seller_rejected() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        // Signed by alice's key for an alice invoice, but submitted
        // as carol's invoice: the signature must not transfer.
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "gasless", 1);
        c.create_invoice_meta(
            carol(),
            bob(),
            U128(100),
            "gasless".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "no relayer configured")]
    fn meta_rejected_after_relayer_cleared() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        c.set_relayer(None);
        set_predecessor(relayer_acct());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 100, "gasless", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(100),
            "gasless".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "amount exceeds client spend-guard limit")]
    fn meta_enforces_spend_guard() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        // Bob caps NEAR invoices at 500; a gasless 1000 invoice for
        // bob must be refused the same way a direct one would be.
        set_predecessor(bob());
        c.set_policy(U128(500), vec![], U128(0), U128(0), U128(0));
        set_predecessor(relayer_acct());
        let (sig, pk, nonce_b64) = signed_meta_args(alice(), bob(), 1_000, "gasless", 1);
        c.create_invoice_meta(
            alice(),
            bob(),
            U128(1_000),
            "gasless".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![],
            vec![],
        );
    }

    #[test]
    fn daily_cap_exact_boundary() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "a".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(1_000),
            "b".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(1),
            "c".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(2_000), U128(0), U128(0));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        pay_invoice_as(&mut c, 2, bob(), 1_000);
        // Exactly at the cap (2000/2000) is fine; one yocto more is not.
        assert_eq!(c.get_policy(bob()).unwrap().daily_spent, U128(2_000));
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pay_invoice_as(&mut c, 3, bob(), 1);
        }));
        assert!(over.is_err());
    }

    #[test]
    fn owner_transfer_edges() {
        let mut c = setup(contract_acct());
        // Proposing yourself as the new owner is refused.
        let same = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.propose_owner(contract_acct());
        }));
        assert!(same.is_err());
        // A non-owner cannot propose.
        set_predecessor(alice());
        let non_owner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.propose_owner(carol());
        }));
        assert!(non_owner.is_err());
        // Accepting with no proposal outstanding is refused.
        set_predecessor(carol());
        let no_proposal = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.accept_owner();
        }));
        assert!(no_proposal.is_err());
    }

    #[test]
    fn get_invoice_missing_and_list_pagination() {
        let mut c = setup(alice());
        assert_eq!(c.get_invoice(999), None);
        assert!(c.list_invoices(1, 10).is_empty());
        for i in 0..3 {
            c.create_invoice(
                bob(),
                U128(100),
                format!("inv {}", i),
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![],
            );
        }
        assert_eq!(c.get_invoice(2).unwrap().description, "inv 1");
        // from_index 0 is treated as 1.
        let all = c.list_invoices(0, 10);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, 1);
        assert_eq!(all[2].id, 3);
        let page = c.list_invoices(1, 2);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, 1);
        assert_eq!(page[1].id, 2);
        let tail = c.list_invoices(2, 10);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].id, 2);
        // Past the end: empty, never panics.
        assert!(c.list_invoices(4, 5).is_empty());
        assert!(c.list_invoices(1, 0).is_empty());
    }

    #[test]
    #[should_panic(expected = "contract state v4 not found")]
    fn migrate_on_empty_state_panics() {
        // No state was ever written in this context: migrate must
        // refuse instead of initialising a blank contract over live
        // data (a corrupted/missing state is never silently reset).
        set_predecessor(contract_acct());
        Contract::migrate();
    }

    #[test]
    fn random_walk_invariants() {
        // Deterministic 60-action walk (LCG, no rand dependency):
        // create / pay / release / refund / cancel / dispute /
        // withdraw / confirm-external, in random order. After every
        // step the on-chain accounting must match a local model:
        // total_escrowed == sum of Paid-but-unreleased amounts,
        // open count == number of Pending invoices, and the invoice
        // count only ever grows.
        let mut c = setup(alice());
        let mut rng: u64 = 0x9E3779B97F4A7C15;
        let mut next_rand = |rng: &mut u64| -> u64 {
            *rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *rng >> 33
        };
        struct Model {
            status: InvoiceStatus,
            released: bool,
            disputed: bool,
            amount: u128,
        }
        let mut model: Vec<Model> = Vec::new();
        let addr_ref = "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string();
        for _ in 0..60 {
            match next_rand(&mut rng) % 8 {
                0 => {
                    // Create a NEAR invoice (keep headroom under the
                    // 50-open cap so the walk never stalls).
                    if c.get_open_invoice_count(alice()) < 10 {
                        let amount = 1 + next_rand(&mut rng) % 1000;
                        let due = if next_rand(&mut rng) % 2 == 0 {
                            Some(14)
                        } else {
                            None
                        };
                        set_predecessor(alice());
                        let id = c.create_invoice(
                            bob(),
                            U128(amount as u128),
                            format!("walk {}", model.len()),
                            due,
                            Currency::Near,
                            vec![],
                            0,
                            vec![],
                            vec![],
                        );
                        assert_eq!(id as usize, model.len() + 1);
                        model.push(Model {
                            status: InvoiceStatus::Pending,
                            released: false,
                            disputed: false,
                            amount: amount as u128,
                        });
                    }
                }
                1 => {
                    // Pay a random pending invoice.
                    let pend: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Pending)
                        .map(|(i, _)| i)
                        .collect();
                    if !pend.is_empty() {
                        let i = pend[(next_rand(&mut rng) as usize) % pend.len()];
                        pay_invoice_as(&mut c, (i + 1) as u64, bob(), model[i].amount);
                        model[i].status = InvoiceStatus::Paid;
                    }
                }
                2 => {
                    // Release a random paid, unreleased, undisputed
                    // invoice; finalise via the mocked callback.
                    let rel: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| {
                            m.status == InvoiceStatus::Paid && !m.released && !m.disputed
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if !rel.is_empty() {
                        let i = rel[(next_rand(&mut rng) as usize) % rel.len()];
                        set_predecessor(alice());
                        let _p = c.release_invoice((i + 1) as u64);
                        run_callback(&mut c, (i + 1) as u64, PromiseResult::Successful(vec![]));
                        model[i].released = true;
                    }
                }
                3 => {
                    // Refund a random paid, unreleased invoice.
                    let rf: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Paid && !m.released)
                        .map(|(i, _)| i)
                        .collect();
                    if !rf.is_empty() {
                        let i = rf[(next_rand(&mut rng) as usize) % rf.len()];
                        set_predecessor(alice());
                        let _p = c.refund_invoice((i + 1) as u64);
                        run_callback(&mut c, (i + 1) as u64, PromiseResult::Successful(vec![]));
                        model[i].status = InvoiceStatus::Refunded;
                    }
                }
                4 => {
                    // Cancel a random pending invoice.
                    let pend: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Pending)
                        .map(|(i, _)| i)
                        .collect();
                    if !pend.is_empty() {
                        let i = pend[(next_rand(&mut rng) as usize) % pend.len()];
                        set_predecessor(alice());
                        c.cancel_invoice((i + 1) as u64);
                        model[i].status = InvoiceStatus::Cancelled;
                    }
                }
                5 => {
                    // Dispute a random paid, unreleased, undisputed invoice.
                    let d: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| {
                            m.status == InvoiceStatus::Paid && !m.released && !m.disputed
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if !d.is_empty() {
                        let i = d[(next_rand(&mut rng) as usize) % d.len()];
                        set_predecessor(bob());
                        c.open_dispute((i + 1) as u64, "walk dispute".to_string());
                        model[i].disputed = true;
                    }
                }
                6 => {
                    // Withdraw a random open dispute.
                    let w: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.disputed)
                        .map(|(i, _)| i)
                        .collect();
                    if !w.is_empty() {
                        let i = w[(next_rand(&mut rng) as usize) % w.len()];
                        set_predecessor(bob());
                        c.withdraw_dispute((i + 1) as u64);
                        model[i].disputed = false;
                    }
                }
                _ => {
                    // Confirm external settlement for a random pending
                    // invoice (NEAR invoices only in this walk).
                    let pend: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Pending)
                        .map(|(i, _)| i)
                        .collect();
                    if !pend.is_empty() {
                        let i = pend[(next_rand(&mut rng) as usize) % pend.len()];
                        set_predecessor(alice());
                        c.confirm_external_payment((i + 1) as u64, addr_ref.clone());
                        model[i].status = InvoiceStatus::Paid;
                        model[i].released = true;
                    }
                }
            }
            // Invariants after every single step.
            let expected_escrow: u128 = model
                .iter()
                .filter(|m| m.status == InvoiceStatus::Paid && !m.released)
                .map(|m| m.amount)
                .sum();
            assert_eq!(
                c.get_total_escrowed(),
                U128(expected_escrow),
                "escrow invariant broke"
            );
            let expected_open = model
                .iter()
                .filter(|m| m.status == InvoiceStatus::Pending)
                .count() as u64;
            assert_eq!(
                c.get_open_invoice_count(alice()),
                expected_open,
                "open-count invariant broke"
            );
            assert_eq!(
                c.get_invoice_count(),
                model.len() as u64,
                "invoice count must only grow"
            );
        }
        // The walk must actually have exercised the contract.
        assert!(
            model.len() >= 5,
            "walk created too few invoices: {}",
            model.len()
        );
        assert!(
            model.iter().any(|m| m.status == InvoiceStatus::Paid),
            "walk never paid an invoice"
        );
        assert!(
            model.iter().any(|m| m.status == InvoiceStatus::Refunded),
            "walk never refunded an invoice"
        );
    }

    // ---- v4: USDC spend-guard caps ----

    #[test]
    #[should_panic(expected = "amount exceeds client USDC spend-guard limit")]
    fn usdc_max_amount_enforced_at_creation() {
        let mut c = setup(bob());
        // Bob caps USDC invoices at 5.00 USDC (5_000_000 micro-USDC).
        c.set_policy(U128(0), vec![], U128(0), U128(5_000_000), U128(0));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "too big usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
    }

    #[test]
    fn usdc_max_amount_boundary_ok() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![], U128(0), U128(5_000_000), U128(0));
        set_predecessor(alice());
        // Exactly at the cap is allowed.
        let id = c.create_invoice(
            bob(),
            U128(5_000_000),
            "at cap".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert_eq!(id, 1);
    }

    #[test]
    fn usdc_daily_cap_enforced_at_confirmation() {
        let mut c = setup(alice());
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(0), U128(0), U128(15_000_000));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "a".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "b".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        let addr = "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string();
        c.confirm_external_payment(1, addr.clone());
        assert_eq!(
            c.get_usdc_policy(bob()).unwrap().daily_spent,
            U128(10_000_000)
        );
        // 10M + 10M = 20M > 15M/day: the second confirmation is refused.
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.confirm_external_payment(2, addr);
        }));
        assert!(over.is_err());
        // The refused invoice is still Pending, and the accounting
        // still shows only the first 10M.
        assert_eq!(c.get_invoice(2).unwrap().status, InvoiceStatus::Pending);
        assert_eq!(
            c.get_usdc_policy(bob()).unwrap().daily_spent,
            U128(10_000_000)
        );
    }

    #[test]
    fn usdc_daily_cap_resets_next_day() {
        let mut c = setup(alice());
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(0), U128(0), U128(15_000_000));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "a".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "b".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        let addr = "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string();
        c.confirm_external_payment(1, addr.clone());
        // Next UTC day the quota resets and the same confirmation works.
        set_time(alice(), ONE_DAY_NS);
        c.confirm_external_payment(2, addr);
        assert_eq!(c.get_invoice(2).unwrap().status, InvoiceStatus::Paid);
        assert_eq!(
            c.get_usdc_policy(bob()).unwrap().daily_spent,
            U128(10_000_000)
        );
        assert_eq!(c.get_usdc_policy(bob()).unwrap().daily_spent_day, 1);
    }

    #[test]
    fn confirm_external_rechecks_allowlist_and_max() {
        let mut c = setup(alice());
        set_predecessor(bob());
        c.set_policy(U128(0), vec![alice()], U128(0), U128(20_000_000), U128(0));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        let addr = "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string();
        // Bob tightens the policy AFTER creation: alice is removed
        // from the allowlist. Confirmation must use the CURRENT policy.
        set_predecessor(bob());
        c.set_policy(U128(0), vec![carol()], U128(0), U128(20_000_000), U128(0));
        set_predecessor(alice());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.confirm_external_payment(1, addr.clone());
        }));
        assert!(blocked.is_err());
        // Bob re-allowlists alice but lowers the USDC cap below the
        // invoice amount: still refused.
        set_predecessor(bob());
        c.set_policy(U128(0), vec![alice()], U128(0), U128(5_000_000), U128(0));
        set_predecessor(alice());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.confirm_external_payment(1, addr);
        }));
        assert!(blocked.is_err());
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Pending);
    }

    #[test]
    fn set_policy_stores_usdc_caps_and_preserves_daily_spent() {
        let mut c = setup(alice());
        set_predecessor(bob());
        c.set_policy(
            U128(0),
            vec![],
            U128(0),
            U128(50_000_000),
            U128(100_000_000),
        );
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(10_000_000),
            "usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        // Edit the settings: USDC daily accounting must survive, like
        // the NEAR accounting does (M-03).
        set_predecessor(bob());
        c.set_policy(
            U128(0),
            vec![],
            U128(0),
            U128(60_000_000),
            U128(100_000_000),
        );
        let usdc = c.get_usdc_policy(bob()).unwrap();
        assert_eq!(usdc.max_amount, U128(60_000_000));
        assert_eq!(usdc.max_total_per_day, U128(100_000_000));
        assert_eq!(usdc.daily_spent, U128(10_000_000));
        assert_eq!(usdc.daily_spent_day, 0);
    }

    #[test]
    fn confirm_near_invoice_without_usdc_policy_still_works() {
        // No regression: a NEAR invoice confirmed externally works
        // exactly as in v3 when no USDC policy exists at all.
        let mut c = setup(alice());
        assert_eq!(c.get_usdc_policy(bob()), None);
        c.create_invoice(
            bob(),
            U128(1_000),
            "near".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Paid);
        assert!(inv.released);
    }

    #[test]
    fn usdc_cap_zero_means_no_limit() {
        // All-zero USDC caps = no limits: a large USDC invoice can be
        // created and confirmed freely.
        let mut c = setup(alice());
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(0), U128(0), U128(0));
        set_predecessor(alice());
        c.create_invoice(
            bob(),
            U128(25_000_000),
            "big usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
            vec![],
            vec![],
        );
        c.confirm_external_payment(1, "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string());
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Paid);
        // Zero caps still record the spend (accounting runs even when
        // the cap itself is unlimited).
        assert_eq!(
            c.get_usdc_policy(bob()).unwrap().daily_spent,
            U128(25_000_000)
        );
    }

    #[test]
    fn get_usdc_policy_none_by_default() {
        let c = setup(alice());
        assert_eq!(c.get_usdc_policy(alice()), None);
        assert_eq!(c.get_usdc_policy(bob()), None);
        assert_eq!(c.get_policy(bob()), None);
    }

    // ---- v5: funded milestones and programmable splits ----

    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn milestone(description: &str, amount: u128) -> MilestoneInput {
        MilestoneInput {
            description: description.to_string(),
            amount: U128(amount),
        }
    }

    fn split(account: AccountId, share_bps: u16) -> SplitShareInput {
        SplitShareInput {
            account: account.to_string(),
            share_bps,
        }
    }

    /// Run the v5 payout callback as the contract itself, with a
    /// mocked promise result.
    fn run_payout_callback(c: &mut Contract, id: u64, result: PromiseResult) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(contract_acct())
            .current_account_id(contract_acct())
            .build();
        testing_env_with_promise_results(ctx, result);
        c.on_payout_callback(id);
    }

    /// Drive a v5 payout to completion with successful transfers.
    /// Returns the number of callback invocations (== steps paid).
    fn drain_payout(c: &mut Contract, id: u64) -> u32 {
        let mut steps = 0;
        while c.pending_payouts.contains_key(&id) {
            run_payout_callback(c, id, PromiseResult::Successful(vec![]));
            steps += 1;
            assert!(steps <= 10, "payout did not drain");
        }
        steps
    }

    /// Alice sells to bob: 1,000 yocto, milestones 600/400, no
    /// splits, due in 14 days. Paid in full up front.
    fn milestone_invoice_paid(c: &mut Contract) -> u64 {
        let id = c.create_invoice(
            bob(),
            U128(1_000),
            "milestone work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![milestone("part 1", 600), milestone("part 2", 400)],
            vec![],
        );
        assert_eq!(id, 1);
        pay_invoice_as(c, 1, bob(), 1_000);
        assert_eq!(c.get_total_escrowed(), U128(1_000));
        id
    }

    /// Alice sells to bob: 10 NEAR, milestones 6 + 4 NEAR, splits
    /// alice 7000 / carol 3000. Paid in full up front.
    fn split_invoice_paid(c: &mut Contract) -> u64 {
        let id = c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "split work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![
                milestone("part 1", 6 * ONE_NEAR),
                milestone("part 2", 4 * ONE_NEAR),
            ],
            vec![split(alice(), 7_000), split(carol(), 3_000)],
        );
        assert_eq!(id, 1);
        pay_invoice_as(c, 1, bob(), 10 * ONE_NEAR);
        assert_eq!(c.get_total_escrowed(), U128(10 * ONE_NEAR));
        id
    }

    #[test]
    fn get_version_returns_5() {
        let c = setup(alice());
        assert_eq!(c.get_version(), 5);
    }

    #[test]
    fn milestones_create_and_views() {
        let mut c = setup(alice());
        let id = c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "work".to_string(),
            Some(14),
            Currency::Near,
            vec![],
            0,
            vec![
                milestone("design", 6 * ONE_NEAR),
                milestone("build", 4 * ONE_NEAR),
            ],
            vec![split(carol(), 10_000)],
        );
        assert_eq!(id, 1);
        // The invoice itself is unchanged by the v5 plan.
        let inv = c.get_invoice(1).unwrap();
        assert_eq!(inv.amount, U128(10 * ONE_NEAR));
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert!(!inv.released);
        // Views return the plan in creation order, Pending.
        let ms = c.get_milestones(1);
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].description, "design");
        assert_eq!(ms[0].amount, U128(6 * ONE_NEAR));
        assert_eq!(ms[0].state, MilestoneState::Pending);
        assert_eq!(ms[0].submitted_at, None);
        assert_eq!(ms[0].change_reason, None);
        assert_eq!(ms[1].description, "build");
        assert_eq!(ms[1].amount, U128(4 * ONE_NEAR));
        let sp = c.get_splits(1);
        assert_eq!(sp.len(), 1);
        assert_eq!(sp[0].account, carol());
        assert_eq!(sp[0].share_bps, 10_000);
    }

    #[test]
    fn milestones_views_empty_for_plain_invoice() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(1_000),
            "plain".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![],
        );
        assert!(c.get_milestones(1).is_empty());
        assert!(c.get_splits(1).is_empty());
        assert!(c.get_milestones(999).is_empty());
        assert!(c.get_splits(999).is_empty());
    }

    #[test]
    fn milestone_submit_approve_flow() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        // Submit milestone 0 as the seller.
        set_predecessor(alice());
        c.submit_work(1, 0);
        let m0 = &c.get_milestones(1)[0];
        assert_eq!(m0.state, MilestoneState::Submitted);
        assert_eq!(m0.submitted_at, Some(0));
        // Approve as the client: funds release immediately, via the
        // payout callback (no splits = 100% to the seller).
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        // Not released yet: the callback has not run.
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Submitted);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_milestones(1)[1].state, MilestoneState::Pending);
        assert_eq!(c.get_total_escrowed(), U128(400));
        // Partially released: the invoice itself is NOT released.
        assert!(!c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Paid);
        // Milestone 1 the same way: now the invoice is fully released.
        set_predecessor(alice());
        c.submit_work(1, 1);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 1);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[1].state, MilestoneState::Released);
        assert_eq!(c.get_total_escrowed(), U128(0));
        assert!(c.get_invoice(1).unwrap().released);
    }

    #[test]
    fn milestone_request_changes_and_resubmit() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        // Client asks for changes: state + reason recorded.
        set_predecessor(bob());
        c.request_changes(1, 0, "logo is wrong".to_string());
        let m0 = &c.get_milestones(1)[0];
        assert_eq!(m0.state, MilestoneState::ChangesRequested);
        assert_eq!(m0.change_reason.as_deref(), Some("logo is wrong"));
        assert_eq!(m0.submitted_at, None);
        // Approval is refused while changes are requested.
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(blocked.is_err());
        // Seller resubmits: reason cleared, window restarts.
        set_predecessor(alice());
        c.submit_work(1, 0);
        let m0 = &c.get_milestones(1)[0];
        assert_eq!(m0.state, MilestoneState::Submitted);
        assert_eq!(m0.change_reason, None);
        assert_eq!(m0.submitted_at, Some(0));
        // Now approval works.
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
    }

    #[test]
    #[should_panic(expected = "change reason must not be empty")]
    fn milestone_request_changes_rejects_empty_reason() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        c.request_changes(1, 0, "   ".to_string());
    }

    #[test]
    fn milestone_double_approve_rejected() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        // A second approval while the payout is in flight is refused.
        let in_flight = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(in_flight.is_err());
        assert_eq!(drain_payout(&mut c, 1), 1);
        // And once Released, approval is refused again.
        set_predecessor(bob());
        let released = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(released.is_err());
        assert_eq!(c.get_total_escrowed(), U128(400));
    }

    #[test]
    fn milestone_claim_twice_and_approve_after_claim_rejected() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        // Client silent for 14 days: seller claims.
        set_time(alice(), 14 * ONE_DAY_NS);
        let _p = c.claim_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        // A second claim is refused.
        set_predecessor(alice());
        let second_claim = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_milestone(1, 0);
        }));
        assert!(second_claim.is_err());
        // Approval after a claim is refused too.
        set_predecessor(bob());
        let after_claim = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(after_claim.is_err());
        assert_eq!(c.get_total_escrowed(), U128(400));
    }

    #[test]
    #[should_panic(expected = "inspection window has not passed yet")]
    fn milestone_claim_before_window_rejected() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        // One nanosecond short of the 14-day window.
        set_time(alice(), 14 * ONE_DAY_NS - 1);
        c.claim_milestone(1, 0);
    }

    #[test]
    fn milestone_claim_at_window_boundary_ok() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        // Exactly at the 14-day boundary the claim works.
        set_time(alice(), 14 * ONE_DAY_NS);
        let _p = c.claim_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_total_escrowed(), U128(400));
    }

    #[test]
    fn milestone_claim_window_restarts_on_resubmit() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        // 13 days pass, client asks for changes, seller resubmits:
        // the window restarts from the resubmission.
        set_time(bob(), 13 * ONE_DAY_NS);
        c.request_changes(1, 0, "fix it".to_string());
        set_time(alice(), 13 * ONE_DAY_NS);
        c.submit_work(1, 0);
        // 14 days after the FIRST submission is only 1 day after the
        // resubmission: the claim is still too early.
        set_time(alice(), 14 * ONE_DAY_NS);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_milestone(1, 0);
        }));
        assert!(early.is_err());
        // 14 days after the resubmission it works.
        set_time(alice(), 27 * ONE_DAY_NS);
        let _p = c.claim_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
    }

    #[test]
    fn milestone_dispute_blocks_approve_claim_release() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        c.open_dispute(1, "work not delivered".to_string());
        // Approval, claim (even past the window) and full release
        // are all blocked while disputed.
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(blocked.is_err());
        set_time(alice(), 15 * ONE_DAY_NS);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_milestone(1, 0);
        }));
        assert!(blocked.is_err());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_invoice(1);
        }));
        assert!(blocked.is_err());
        // Withdraw the dispute: approval works again.
        set_predecessor(bob());
        c.withdraw_dispute(1);
        let _p = c.approve_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
    }

    #[test]
    fn milestone_released_stays_released_during_dispute() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        // Client disputes the rest: milestone 0 stays Released.
        // (drain_payout leaves the predecessor as the contract
        // itself, so switch back to the client first.)
        set_predecessor(bob());
        c.open_dispute(1, "part 2 is late".to_string());
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_total_escrowed(), U128(400));
        // Milestone 1 cannot be approved while disputed...
        set_predecessor(alice());
        c.submit_work(1, 1);
        set_predecessor(bob());
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 1);
        }));
        assert!(blocked.is_err());
        // ...but the seller can still refund the unreleased 400,
        // even during the dispute.
        set_predecessor(alice());
        let _p = c.refund_invoice(1);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        assert_eq!(c.get_total_escrowed(), U128(0));
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_milestones(1)[1].state, MilestoneState::Submitted);
    }

    #[test]
    fn milestone_refund_returns_only_unreleased() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        // Refund: only the unreleased 400 goes back (600 stays paid).
        set_predecessor(alice());
        let _p = c.refund_invoice(1);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert!(payout.is_refund);
        assert_eq!(payout.total, U128(400));
        assert_eq!(payout.steps.len(), 1);
        assert_eq!(payout.steps[0].recipient, bob());
        assert_eq!(payout.steps[0].amount, U128(400));
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn milestone_claim_refund_returns_only_unreleased() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(drain_payout(&mut c, 1), 1);
        // Seller goes silent; past the due date the client claims
        // the refund — only the unreleased 400.
        set_time(bob(), 15 * ONE_DAY_NS);
        let _p = c.claim_refund(1);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert_eq!(payout.total, U128(400));
        assert_eq!(payout.steps[0].recipient, bob());
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Refunded);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn milestone_release_invoice_releases_all_remaining() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        // Only milestone 0 is submitted; milestone 1 is still
        // Pending. release_invoice releases BOTH at once.
        set_predecessor(alice());
        c.submit_work(1, 0);
        let _p = c.release_invoice(1);
        assert_eq!(drain_payout(&mut c, 1), 2);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_milestones(1)[1].state, MilestoneState::Released);
        assert!(c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn milestone_wrong_caller_and_state() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        // Only the seller submits; only the client approves /
        // requests changes; only the seller claims.
        set_predecessor(bob());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.submit_work(1, 0);
        }));
        assert!(bad.is_err());
        set_predecessor(alice());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(bad.is_err());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_changes(1, 0, "no".to_string());
        }));
        assert!(bad.is_err());
        set_predecessor(bob());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_milestone(1, 0);
        }));
        assert!(bad.is_err());
        // Approve / claim / request-changes need a Submitted
        // milestone; submit needs Pending or ChangesRequested.
        set_predecessor(bob());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.approve_milestone(1, 0);
        }));
        assert!(bad.is_err());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_changes(1, 0, "too early".to_string());
        }));
        assert!(bad.is_err());
        // Unknown milestone index.
        set_predecessor(alice());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.submit_work(1, 5);
        }));
        assert!(bad.is_err());
        // Submit before payment is refused.
        let mut c2 = setup(alice());
        c2.create_invoice(
            bob(),
            U128(1_000),
            "unpaid".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![milestone("a", 1_000)],
            vec![],
        );
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c2.submit_work(1, 0);
        }));
        assert!(bad.is_err());
    }

    #[test]
    fn milestone_create_validation() {
        let mut c = setup(alice());
        // Six milestones: too many.
        let six: Vec<MilestoneInput> = (0..6).map(|i| milestone(&format!("m{}", i), 100)).collect();
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(600),
                "six".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                six,
                vec![],
            );
        }));
        assert!(bad.is_err());
        // Amounts must sum exactly to the invoice amount.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "sum".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![milestone("a", 600), milestone("b", 300)],
                vec![],
            );
        }));
        assert!(bad.is_err());
        // A zero-amount milestone is refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "zero".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![milestone("a", 1_000), milestone("b", 0)],
                vec![],
            );
        }));
        assert!(bad.is_err());
        // A 201-byte milestone description is refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "long".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![milestone(&"x".repeat(201), 1_000)],
                vec![],
            );
        }));
        assert!(bad.is_err());
        // Milestones and splits are NEAR-only.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "usdc-m".to_string(),
                None,
                Currency::Usdc,
                vec![],
                0,
                vec![milestone("a", 1_000)],
                vec![],
            );
        }));
        assert!(bad.is_err());
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(1_000),
                "usdc-s".to_string(),
                None,
                Currency::Usdc,
                vec![],
                0,
                vec![],
                vec![split(carol(), 10_000)],
            );
        }));
        assert!(bad.is_err());
        // Five milestones summing exactly: the legal maximum works.
        let five: Vec<MilestoneInput> =
            (0..5).map(|i| milestone(&format!("m{}", i), 200)).collect();
        let id = c.create_invoice(
            bob(),
            U128(1_000),
            "five".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            five,
            vec![],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_milestones(1).len(), 5);
    }

    #[test]
    #[should_panic(expected = "split shares must sum to 10000")]
    fn split_validation_sum_below() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "sum".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 5_000), split(carol(), 4_999)],
        );
    }

    #[test]
    #[should_panic(expected = "split shares must sum to 10000")]
    fn split_validation_sum_above() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "sum".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 5_000), split(carol(), 5_001)],
        );
    }

    #[test]
    #[should_panic(expected = "split recipients must be unique")]
    fn split_validation_duplicate() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "dup".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 5_000), split(alice(), 5_000)],
        );
    }

    #[test]
    #[should_panic(expected = "split recipient account must not be empty")]
    fn split_validation_empty_account() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "empty".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![SplitShareInput {
                account: "".to_string(),
                share_bps: 10_000,
            }],
        );
    }

    #[test]
    #[should_panic(expected = "split recipient account is not a valid account id")]
    fn split_validation_invalid_account() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "bad".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![SplitShareInput {
                account: "x".to_string(),
                share_bps: 10_000,
            }],
        );
    }

    #[test]
    #[should_panic(expected = "at most 3 split recipients")]
    fn split_validation_too_many() {
        let mut c = setup(alice());
        let dave: AccountId = "dave.testnet".parse().unwrap();
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "many".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![
                split(alice(), 2_500),
                split(bob(), 2_500),
                split(carol(), 2_500),
                split(dave, 2_500),
            ],
        );
    }

    #[test]
    #[should_panic(expected = "split share must be greater than zero")]
    fn split_validation_zero_share() {
        let mut c = setup(alice());
        c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "zero".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 0), split(carol(), 10_000)],
        );
    }

    #[test]
    fn split_validation_below_minimum_and_boundary() {
        let mut c = setup(alice());
        // 0.003 NEAR split 50/50 = 0.0015 NEAR per share: below the
        // 0.002 NEAR minimum, refused.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(3 * ONE_NEAR / 1_000),
                "tiny".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![],
                vec![split(alice(), 5_000), split(carol(), 5_000)],
            );
        }));
        assert!(bad.is_err());
        // Exactly at the minimum (0.004 NEAR, 50/50 = 0.002 each) works.
        let id = c.create_invoice(
            bob(),
            U128(4 * ONE_NEAR / 1_000),
            "at-min".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 5_000), split(carol(), 5_000)],
        );
        assert_eq!(id, 1);
        // The minimum applies per MILESTONE, not per invoice: a big
        // invoice with one tiny milestone is refused even though the
        // invoice total is large.
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(
                bob(),
                U128(10 * ONE_NEAR),
                "tiny-ms".to_string(),
                None,
                Currency::Near,
                vec![],
                0,
                vec![
                    milestone("big", 10 * ONE_NEAR - 3 * ONE_NEAR / 1_000),
                    milestone("tiny", 3 * ONE_NEAR / 1_000),
                ],
                vec![split(alice(), 5_000), split(carol(), 5_000)],
            );
        }));
        assert!(bad.is_err());
    }

    #[test]
    fn split_distribution_on_approve() {
        let mut c = setup(alice());
        split_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        // Milestone 0 is 6 NEAR, splits 70/30: alice 4.2 NEAR,
        // carol 1.8 NEAR, as two sequential payout steps.
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert!(!payout.is_refund);
        assert_eq!(payout.total, U128(6 * ONE_NEAR));
        assert_eq!(payout.steps.len(), 2);
        assert_eq!(payout.steps[0].recipient, alice());
        assert_eq!(
            payout.steps[0].amount,
            U128(4_200_000_000_000_000_000_000_000)
        );
        assert_eq!(payout.steps[0].milestone_index, Some(0));
        assert_eq!(payout.steps[1].recipient, carol());
        assert_eq!(
            payout.steps[1].amount,
            U128(1_800_000_000_000_000_000_000_000)
        );
        // After the first step the milestone is still Submitted; the
        // second callback finalises it.
        run_payout_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Submitted);
        assert!(c.pending_payouts.contains_key(&1));
        run_payout_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert!(!c.pending_payouts.contains_key(&1));
        assert_eq!(c.get_total_escrowed(), U128(4 * ONE_NEAR));
        // Milestone 1: 4 NEAR, alice 2.8 / carol 1.2.
        set_predecessor(alice());
        c.submit_work(1, 1);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 1);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert_eq!(
            payout.steps[0].amount,
            U128(2_800_000_000_000_000_000_000_000)
        );
        assert_eq!(
            payout.steps[1].amount,
            U128(1_200_000_000_000_000_000_000_000)
        );
        assert_eq!(drain_payout(&mut c, 1), 2);
        assert!(c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn split_distribution_on_full_release_without_milestones() {
        let mut c = setup(alice());
        // Splits without milestones: release_invoice distributes
        // the full amount by the splits.
        let id = c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR),
            "splits only".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 7_000), split(carol(), 3_000)],
        );
        assert_eq!(id, 1);
        pay_invoice_as(&mut c, 1, bob(), 10 * ONE_NEAR);
        set_predecessor(alice());
        let _p = c.release_invoice(1);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert_eq!(payout.steps.len(), 2);
        assert_eq!(payout.steps[0].recipient, alice());
        assert_eq!(payout.steps[0].amount, U128(7 * ONE_NEAR));
        assert_eq!(payout.steps[1].recipient, carol());
        assert_eq!(payout.steps[1].amount, U128(3 * ONE_NEAR));
        assert_eq!(drain_payout(&mut c, 1), 2);
        assert!(c.get_invoice(1).unwrap().released);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn split_remainder_goes_to_first_recipient() {
        let mut c = setup(alice());
        // 10 NEAR + 1 yocto, 50/50: each share floors to 5 NEAR and
        // the 1-yocto remainder goes to the first recipient (alice).
        let id = c.create_invoice(
            bob(),
            U128(10 * ONE_NEAR + 1),
            "odd".to_string(),
            None,
            Currency::Near,
            vec![],
            0,
            vec![],
            vec![split(alice(), 5_000), split(carol(), 5_000)],
        );
        assert_eq!(id, 1);
        pay_invoice_as(&mut c, 1, bob(), 10 * ONE_NEAR + 1);
        set_predecessor(alice());
        let _p = c.release_invoice(1);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert_eq!(payout.steps[0].amount, U128(5 * ONE_NEAR + 1));
        assert_eq!(payout.steps[1].amount, U128(5 * ONE_NEAR));
        assert_eq!(
            payout.steps[0].amount.0 + payout.steps[1].amount.0,
            10 * ONE_NEAR + 1
        );
        assert_eq!(drain_payout(&mut c, 1), 2);
        assert_eq!(c.get_total_escrowed(), U128(0));
    }

    #[test]
    fn split_payout_failure_resumes_from_failed_step() {
        let mut c = setup(alice());
        split_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        // Step 0 (alice 4.2 NEAR) fails: nothing is finalised, the
        // payout stays queued at step 0, and a retry resumes it.
        run_payout_callback(&mut c, 1, PromiseResult::Failed);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Submitted);
        assert_eq!(c.get_total_escrowed(), U128(10 * ONE_NEAR));
        assert!(c.pending_payouts.contains_key(&1));
        assert_eq!(c.pending_payouts.get(&1).unwrap().next_step, 0);
        // Retry: the same approval resumes the queued payout.
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(c.pending_payouts.get(&1).unwrap().next_step, 0);
        // Step 0 succeeds, step 1 (carol) fails: the retry after
        // that must resume at step 1 only, never re-pay alice.
        run_payout_callback(&mut c, 1, PromiseResult::Successful(vec![]));
        assert_eq!(c.pending_payouts.get(&1).unwrap().next_step, 1);
        run_payout_callback(&mut c, 1, PromiseResult::Failed);
        assert_eq!(c.pending_payouts.get(&1).unwrap().next_step, 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Submitted);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        assert_eq!(c.pending_payouts.get(&1).unwrap().next_step, 1);
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_milestones(1)[0].state, MilestoneState::Released);
        assert_eq!(c.get_total_escrowed(), U128(4 * ONE_NEAR));
    }

    #[test]
    fn split_default_no_splits_pays_seller() {
        let mut c = setup(alice());
        milestone_invoice_paid(&mut c);
        set_predecessor(alice());
        c.submit_work(1, 0);
        set_predecessor(bob());
        let _p = c.approve_milestone(1, 0);
        let payout = c.pending_payouts.get(&1).unwrap().clone();
        assert_eq!(payout.steps.len(), 1);
        assert_eq!(payout.steps[0].recipient, alice());
        assert_eq!(payout.steps[0].amount, U128(600));
        assert_eq!(drain_payout(&mut c, 1), 1);
        assert_eq!(c.get_total_escrowed(), U128(400));
    }

    #[test]
    fn meta_invoice_with_milestones_and_splits() {
        let mut c = setup(contract_acct());
        c.set_relayer(Some(relayer_acct()));
        set_predecessor(relayer_acct());
        // The plan is part of the signed message: sign the exact
        // JSON the contract serializes.
        let milestones_json = r#"[{"description":"part 1","amount":"6000000000000000000000000"},{"description":"part 2","amount":"4000000000000000000000000"}]"#;
        let splits_json = r#"[{"account":"carol.testnet","share_bps":10000}]"#;
        let (sig, pk, nonce_b64) = signed_meta_args_with_plan(
            alice(),
            bob(),
            10 * ONE_NEAR,
            "gasless milestones",
            1,
            milestones_json,
            splits_json,
        );
        let id = c.create_invoice_meta(
            alice(),
            bob(),
            U128(10 * ONE_NEAR),
            "gasless milestones".to_string(),
            1,
            sig,
            pk,
            nonce_b64,
            None,
            vec![
                milestone("part 1", 6 * ONE_NEAR),
                milestone("part 2", 4 * ONE_NEAR),
            ],
            vec![split(carol(), 10_000)],
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_milestones(1).len(), 2);
        assert_eq!(c.get_splits(1)[0].account, carol());
        // A signature over a DIFFERENT plan must be rejected.
        let (sig2, pk2, nonce_b64_2) = signed_meta_args_with_plan(
            alice(),
            bob(),
            10 * ONE_NEAR,
            "gasless milestones",
            2,
            "[]",
            "[]",
        );
        let tampered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice_meta(
                alice(),
                bob(),
                U128(10 * ONE_NEAR),
                "gasless milestones".to_string(),
                2,
                sig2,
                pk2,
                nonce_b64_2,
                None,
                vec![milestone("part 1", 6 * ONE_NEAR)],
                vec![],
            );
        }));
        assert!(tampered.is_err());
    }

    #[test]
    fn milestone_random_walk_invariants() {
        // Deterministic 80-action walk (LCG, no rand dependency) over
        // milestone invoices: create (plain or 2-milestone) / pay /
        // submit / approve / request-changes / release / refund /
        // cancel / dispute / withdraw. After every step the on-chain
        // accounting must match a local model: total_escrowed ==
        // sum over Paid invoices of (amount - released milestones),
        // open count == number of Pending invoices, and the invoice
        // count only ever grows.
        let mut c = setup(alice());
        let mut rng: u64 = 0xA0761D6478BD642F;
        let mut next_rand = |rng: &mut u64| -> u64 {
            *rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *rng >> 33
        };
        #[derive(Clone, Copy, PartialEq)]
        enum MState {
            Pending,
            Submitted,
            ChangesRequested,
            Released,
        }
        struct Model {
            status: InvoiceStatus,
            released: bool,
            disputed: bool,
            amount: u128,
            milestones: Vec<MState>,
            milestone_amounts: Vec<u128>,
        }
        let mut model: Vec<Model> = Vec::new();
        for _ in 0..80 {
            match next_rand(&mut rng) % 10 {
                0 => {
                    // Create: plain, or 2 milestones (600/400 split
                    // of a 1000-yocto invoice).
                    if c.get_open_invoice_count(alice()) < 10 {
                        let with_ms = next_rand(&mut rng) % 2 == 0;
                        // Amounts are >= 2 so a 2-milestone split
                        // never produces a zero-amount milestone.
                        let amount = 2 + next_rand(&mut rng) % 999;
                        set_predecessor(alice());
                        if with_ms {
                            let a = amount / 2;
                            let b = amount - a;
                            let id = c.create_invoice(
                                bob(),
                                U128(amount as u128),
                                format!("walk-ms {}", model.len()),
                                None,
                                Currency::Near,
                                vec![],
                                0,
                                vec![milestone("a", a as u128), milestone("b", b as u128)],
                                vec![],
                            );
                            assert_eq!(id as usize, model.len() + 1);
                            model.push(Model {
                                status: InvoiceStatus::Pending,
                                released: false,
                                disputed: false,
                                amount: amount as u128,
                                milestones: vec![MState::Pending, MState::Pending],
                                milestone_amounts: vec![a as u128, b as u128],
                            });
                        } else {
                            let id = c.create_invoice(
                                bob(),
                                U128(amount as u128),
                                format!("walk {}", model.len()),
                                None,
                                Currency::Near,
                                vec![],
                                0,
                                vec![],
                                vec![],
                            );
                            assert_eq!(id as usize, model.len() + 1);
                            model.push(Model {
                                status: InvoiceStatus::Pending,
                                released: false,
                                disputed: false,
                                amount: amount as u128,
                                milestones: vec![],
                                milestone_amounts: vec![],
                            });
                        }
                    }
                }
                1 => {
                    // Pay a random pending invoice.
                    let pend: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Pending)
                        .map(|(i, _)| i)
                        .collect();
                    if !pend.is_empty() {
                        let i = pend[(next_rand(&mut rng) as usize) % pend.len()];
                        pay_invoice_as(&mut c, (i + 1) as u64, bob(), model[i].amount);
                        model[i].status = InvoiceStatus::Paid;
                    }
                }
                2 => {
                    // Submit a random Pending/ChangesRequested milestone.
                    let sub: Vec<(usize, usize)> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Paid)
                        .flat_map(|(i, m)| {
                            m.milestones
                                .iter()
                                .enumerate()
                                .filter(|(_, s)| {
                                    **s == MState::Pending || **s == MState::ChangesRequested
                                })
                                .map(move |(j, _)| (i, j))
                        })
                        .collect();
                    if !sub.is_empty() {
                        let (i, j) = sub[(next_rand(&mut rng) as usize) % sub.len()];
                        set_predecessor(alice());
                        c.submit_work((i + 1) as u64, j as u32);
                        model[i].milestones[j] = MState::Submitted;
                    }
                }
                3 => {
                    // Approve a random Submitted, undisputed milestone.
                    let app: Vec<(usize, usize)> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Paid && !m.disputed)
                        .flat_map(|(i, m)| {
                            m.milestones
                                .iter()
                                .enumerate()
                                .filter(|(_, s)| **s == MState::Submitted)
                                .map(move |(j, _)| (i, j))
                        })
                        .collect();
                    if !app.is_empty() {
                        let (i, j) = app[(next_rand(&mut rng) as usize) % app.len()];
                        set_predecessor(bob());
                        let _p = c.approve_milestone((i + 1) as u64, j as u32);
                        assert_eq!(drain_payout(&mut c, (i + 1) as u64), 1);
                        model[i].milestones[j] = MState::Released;
                        if model[i].milestones.iter().all(|s| *s == MState::Released)
                            && !model[i].milestones.is_empty()
                        {
                            model[i].released = true;
                        }
                    }
                }
                4 => {
                    // Request changes on a random Submitted milestone.
                    let ch: Vec<(usize, usize)> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Paid)
                        .flat_map(|(i, m)| {
                            m.milestones
                                .iter()
                                .enumerate()
                                .filter(|(_, s)| **s == MState::Submitted)
                                .map(move |(j, _)| (i, j))
                        })
                        .collect();
                    if !ch.is_empty() {
                        let (i, j) = ch[(next_rand(&mut rng) as usize) % ch.len()];
                        set_predecessor(bob());
                        c.request_changes((i + 1) as u64, j as u32, "walk fix".to_string());
                        model[i].milestones[j] = MState::ChangesRequested;
                    }
                }
                5 => {
                    // Release a random paid, unreleased, undisputed
                    // invoice (plain or milestone: all remaining
                    // milestones at once).
                    let rel: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| {
                            m.status == InvoiceStatus::Paid && !m.released && !m.disputed
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if !rel.is_empty() {
                        let i = rel[(next_rand(&mut rng) as usize) % rel.len()];
                        set_predecessor(alice());
                        let _p = c.release_invoice((i + 1) as u64);
                        // Milestone invoices settle via the payout
                        // callback; plain invoices via the legacy one.
                        if model[i].milestones.is_empty() {
                            run_callback(&mut c, (i + 1) as u64, PromiseResult::Successful(vec![]));
                        } else {
                            drain_payout(&mut c, (i + 1) as u64);
                        }
                        // Legacy plain release leaves no payout record
                        // (drain is a no-op); milestone release marks
                        // every milestone Released.
                        for s in model[i].milestones.iter_mut() {
                            *s = MState::Released;
                        }
                        model[i].released = true;
                    }
                }
                6 => {
                    // Refund a random paid, unreleased invoice.
                    let rf: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Paid && !m.released)
                        .map(|(i, _)| i)
                        .collect();
                    if !rf.is_empty() {
                        let i = rf[(next_rand(&mut rng) as usize) % rf.len()];
                        set_predecessor(alice());
                        let _p = c.refund_invoice((i + 1) as u64);
                        // Milestone invoices refund via the payout
                        // callback; plain invoices via the legacy one.
                        if model[i].milestones.is_empty() {
                            run_callback(&mut c, (i + 1) as u64, PromiseResult::Successful(vec![]));
                        } else {
                            drain_payout(&mut c, (i + 1) as u64);
                        }
                        model[i].status = InvoiceStatus::Refunded;
                    }
                }
                7 => {
                    // Cancel a random pending invoice.
                    let pend: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.status == InvoiceStatus::Pending)
                        .map(|(i, _)| i)
                        .collect();
                    if !pend.is_empty() {
                        let i = pend[(next_rand(&mut rng) as usize) % pend.len()];
                        set_predecessor(alice());
                        c.cancel_invoice((i + 1) as u64);
                        model[i].status = InvoiceStatus::Cancelled;
                    }
                }
                8 => {
                    // Dispute a random paid, unreleased, undisputed invoice.
                    let d: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| {
                            m.status == InvoiceStatus::Paid && !m.released && !m.disputed
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if !d.is_empty() {
                        let i = d[(next_rand(&mut rng) as usize) % d.len()];
                        set_predecessor(bob());
                        c.open_dispute((i + 1) as u64, "walk dispute".to_string());
                        model[i].disputed = true;
                    }
                }
                _ => {
                    // Withdraw a random open dispute.
                    let w: Vec<usize> = model
                        .iter()
                        .enumerate()
                        .filter(|(_, m)| m.disputed)
                        .map(|(i, _)| i)
                        .collect();
                    if !w.is_empty() {
                        let i = w[(next_rand(&mut rng) as usize) % w.len()];
                        set_predecessor(bob());
                        c.withdraw_dispute((i + 1) as u64);
                        model[i].disputed = false;
                    }
                }
            }
            // Invariants after every single step.
            let expected_escrow: u128 = model
                .iter()
                .filter(|m| m.status == InvoiceStatus::Paid && !m.released)
                .map(|m| {
                    let released: u128 = m
                        .milestones
                        .iter()
                        .zip(m.milestone_amounts.iter())
                        .filter(|(s, _)| **s == MState::Released)
                        .map(|(_, a)| *a)
                        .sum();
                    m.amount.saturating_sub(released)
                })
                .sum();
            assert_eq!(
                c.get_total_escrowed(),
                U128(expected_escrow),
                "escrow invariant broke"
            );
            let expected_open = model
                .iter()
                .filter(|m| m.status == InvoiceStatus::Pending)
                .count() as u64;
            assert_eq!(
                c.get_open_invoice_count(alice()),
                expected_open,
                "open-count invariant broke"
            );
            assert_eq!(
                c.get_invoice_count(),
                model.len() as u64,
                "invoice count must only grow"
            );
        }
        // The walk must actually have exercised milestones.
        assert!(
            model.len() >= 5,
            "walk created too few invoices: {}",
            model.len()
        );
        assert!(
            model.iter().any(|m| !m.milestones.is_empty()),
            "walk never created a milestone invoice"
        );
        assert!(
            model
                .iter()
                .any(|m| m.milestones.iter().any(|s| *s == MState::Released)),
            "walk never released a milestone"
        );
        assert!(
            model.iter().any(|m| m.status == InvoiceStatus::Refunded),
            "walk never refunded an invoice"
        );
    }
}
