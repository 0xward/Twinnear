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
//!   max total per day. The policy is enforced at creation AND re-checked
//!   at payment time; the daily cap is accounted in `pay_invoice`.
//!   External (1Click) settlements never touch escrow, so the guard
//!   cannot cover them — they are labelled "external (unverified)".
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

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult,
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

/// Invoice lifecycle. The frontend renders these as
/// Pending / Paid / Refunded / Cancelled.
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq,
)]
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
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq,
)]
#[serde(crate = "near_sdk::serde")]
pub enum Currency {
    Near,
    Usdc,
}

/// One priced line of a multi-line invoice (v2).
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq,
)]
#[serde(crate = "near_sdk::serde")]
pub struct InvoiceLineItem {
    /// Max 200 bytes.
    pub description: String,
    /// 1..=10000.
    pub quantity: u32,
    /// Price per unit, in the invoice currency's smallest unit.
    pub unit_price: U128,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
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

/// Rule-based spend-guard policy, set by an account for itself.
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default,
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    next_invoice_id: u64,
    invoices: LookupMap<u64, Invoice>,
    policies: LookupMap<AccountId, Policy>,
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
}

/// v1 `Invoice`, byte-for-byte identical to the struct deployed on
/// `twinnear.testnet` (13 fields, same order). Used ONLY by `migrate`
/// to read pre-upgrade invoices. The v2 `Invoice` appends its new
/// fields after these, so a v1-encoded invoice is a strict Borsh
/// prefix of a v2-encoded one — except Borsh rejects trailing bytes,
/// which is what makes a second `migrate` panic instead of
/// silently re-running.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug)]
pub struct OldInvoice {
    pub id: u64,
    pub seller: AccountId,
    pub client: AccountId,
    pub amount: U128,
    pub description: String,
    pub status: InvoiceStatus,
    pub released: bool,
    pub created_at: u64,
    pub paid_at: Option<u64>,
    pub external_ref: Option<String>,
    pub due_date: Option<u64>,
    pub disputed: bool,
    pub dispute_reason: Option<String>,
}

/// v1 top-level contract state, field order and `LookupMap` prefixes
/// copied exactly from the deployed v1 (invoices b"i", policies b"p",
/// meta_nonces b"m", pending_transfers b"t", failed_transfers b"f",
/// open_pending_count b"o"). Used ONLY by `migrate`. The v2
/// `Contract` has the same field order and NO new top-level field,
/// so the v1/v2 top-level state blobs are byte-identical — migration
/// only rewrites the values stored under prefix b"i".
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldContract {
    owner: AccountId,
    next_invoice_id: u64,
    invoices: LookupMap<u64, OldInvoice>,
    policies: LookupMap<AccountId, Policy>,
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
            relayer: None,
            meta_nonces: LookupMap::new(b"m"),
            pending_transfers: LookupMap::new(b"t"),
            failed_transfers: LookupMap::new(b"f"),
            open_pending_count: LookupMap::new(b"o"),
            total_escrowed: 0,
            pending_owner: None,
        }
    }

    /// Upgrade the contract state from v1 to v2. The ONLY upgrade
    /// path. Owner only. Reads the v1 state, converts every invoice
    /// (currency = Near, no line items, no tax, subtotal = amount,
    /// tax = 0), and writes the v2 state. All other maps (policies,
    /// meta nonces, pending/failed transfers, open counts) and scalar
    /// fields move over untouched, under the same storage prefixes.
    ///
    /// After migrating, NEVER call `new` again on a redeploy — `new`
    /// would wipe the state. A second `migrate` panics (a v2 invoice
    /// no longer deserializes as `OldInvoice`: Borsh rejects the
    /// trailing bytes) and leaves the state untouched.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldContract =
            env::state_read().expect("contract state v1 not found — nothing to migrate");
        assert_eq!(
            env::predecessor_account_id(),
            old.owner,
            "only the owner can migrate"
        );
        // NOTE: `set`, not `insert` — `insert` first LOADS the stored
        // value (to return the old one), which would try to decode the
        // v1 bytes as a v2 `Invoice` and panic. `set` only marks the
        // cache entry modified; the v2 bytes are written on flush.
        let mut invoices: LookupMap<u64, Invoice> = LookupMap::new(b"i");
        for id in 1..old.next_invoice_id {
            if let Some(old_inv) = old.invoices.get(&id) {
                let invoice = Invoice {
                    id: old_inv.id,
                    seller: old_inv.seller.clone(),
                    client: old_inv.client.clone(),
                    amount: old_inv.amount,
                    description: old_inv.description.clone(),
                    status: old_inv.status.clone(),
                    released: old_inv.released,
                    created_at: old_inv.created_at,
                    paid_at: old_inv.paid_at,
                    external_ref: old_inv.external_ref.clone(),
                    due_date: old_inv.due_date,
                    disputed: old_inv.disputed,
                    dispute_reason: old_inv.dispute_reason.clone(),
                    currency: Currency::Near,
                    items: vec![],
                    tax_rate_bps: 0,
                    subtotal: old_inv.amount,
                    tax_amount: U128(0),
                };
                invoices.set(id, Some(invoice));
            }
        }
        Self {
            owner: old.owner,
            next_invoice_id: old.next_invoice_id,
            invoices,
            policies: old.policies,
            relayer: old.relayer,
            meta_nonces: old.meta_nonces,
            pending_transfers: old.pending_transfers,
            failed_transfers: old.failed_transfers,
            open_pending_count: old.open_pending_count,
            total_escrowed: old.total_escrowed,
            pending_owner: old.pending_owner,
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
    /// NEAR-denominated spend-guard `max_amount` (and the daily cap,
    /// which is only enforced at NEAR-escrow payment time anyway)
    /// cannot apply to a different unit, so those checks are skipped
    /// for USDC — but the allowlist check still applies. The 0.01
    /// NEAR storage deposit still applies: it pays for storage, not
    /// for the invoice value.
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

        // H-06: direct creation pays for its permanent ledger entry.
        if require_deposit {
            assert!(
                env::attached_deposit().as_yoctonear() >= STORAGE_DEPOSIT_YOCTO,
                "creating an invoice locks a 0.01 NEAR storage deposit (one-time, non-refundable)"
            );
        }

        // H-06: at most 50 open invoices per seller.
        let open = self
            .open_pending_count
            .get(&seller)
            .copied()
            .unwrap_or(0);
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
            // v2: a USDC amount is micro-USDC, not yoctoNEAR, so the
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
    /// `pay_invoice` — and skip the NEAR-denominated spend-guard
    /// max_amount / daily cap, though the allowlist still applies).
    /// `items`: line items (max 20); empty = single-line invoice,
    /// which requires `tax_rate_bps == 0`. With items, `amount` must
    /// equal subtotal + tax computed from the items.
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
        )
    }

    /// Verify a seller's NEP-413 ed25519 signature on-chain (M-01).
    /// Reconstructs the exact Borsh payload the wallet signed:
    /// `{ message, nonce: [u8; 32], recipient, callbackUrl: None }`,
    /// where `message` is the canonical
    /// `twinnear:create_invoice|<seller>|<client>|<amount>|<description>|<counter>|<nonceBase64>`.
    fn verify_meta_signature(
        seller: &AccountId,
        client: &AccountId,
        amount: U128,
        description: &str,
        nonce: u64,
        nep413_nonce_b64: &str,
        signature_b64: &str,
        public_key_str: &str,
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
            "twinnear:create_invoice|{}|{}|{}|{}|{}|{}",
            seller, client, amount.0, description, nonce, nep413_nonce_b64
        );
        let mut payload = Vec::new();
        borsh_str(&message, &mut payload);
        payload.extend_from_slice(&nonce_bytes);
        borsh_str(env::current_account_id().as_str(), &mut payload);
        payload.push(0); // callbackUrl: None
        assert!(
            env::ed25519_verify(sig, &payload, pk),
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
        invoice.status = InvoiceStatus::Paid;
        invoice.released = true;
        invoice.paid_at = Some(env::block_timestamp());
        invoice.external_ref = Some(reference);
        self.invoices.insert(id, invoice.clone());
        self.decrement_open_count(&invoice.seller);
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
    pub fn release_invoice(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can release");
        assert_eq!(
            invoice.status,
            InvoiceStatus::Paid,
            "invoice is not paid"
        );
        assert!(!invoice.released, "funds already released");
        assert!(!invoice.disputed, "invoice is disputed — release blocked");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        self.start_escrow_transfer(&invoice, true)
    }

    /// Refund the client. Only the seller, only while the invoice is Paid
    /// and funds are still escrowed (not released). Works even while
    /// disputed — a cooperative seller can always return the money.
    /// Finalised by the callback on transfer success (H-02).
    pub fn refund_invoice(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.seller, "only the seller can refund");
        assert_eq!(
            invoice.status,
            InvoiceStatus::Paid,
            "invoice is not paid"
        );
        assert!(!invoice.released, "funds already released");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        self.start_escrow_transfer(&invoice, false)
    }

    /// Claim a refund as the client, after the invoice's due date has
    /// passed (H-03). This is the client's exit when the seller goes
    /// silent. Uses the same callback pattern as release/refund (H-02):
    /// the invoice is only marked Refunded once the transfer succeeds.
    pub fn claim_refund(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(caller, invoice.client, "only the client can claim");
        assert_eq!(
            invoice.status,
            InvoiceStatus::Paid,
            "invoice is not paid"
        );
        assert!(!invoice.released, "funds already released");
        assert!(
            !self.pending_transfers.contains_key(&id),
            "a transfer for this invoice is already in flight"
        );
        let due = invoice
            .due_date
            .unwrap_or_else(|| env::panic_str("invoice has no due date — claim_refund needs a deadline"));
        assert!(
            env::block_timestamp() >= due,
            "due date has not passed yet"
        );
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
                self.total_escrowed =
                    self.total_escrowed.saturating_sub(invoice.amount.0);
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
            .unwrap_or_else(|| {
                env::panic_str("no failed transfer recorded for this invoice")
            });
        let invoice = self
            .invoices
            .get(&id)
            .unwrap_or_else(|| env::panic_str("invoice not found"))
            .clone();
        assert_eq!(
            invoice.status,
            InvoiceStatus::Paid,
            "invoice is not paid"
        );
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
    pub fn set_policy(
        &mut self,
        max_amount: U128,
        allowed_sellers: Vec<AccountId>,
        max_total_per_day: U128,
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
            account,
            Policy {
                max_amount,
                allowed_sellers: deduped,
                max_total_per_day,
                daily_spent: existing.daily_spent,
                daily_spent_day: existing.daily_spent_day,
            },
        );
    }

    // ---- Views ----

    /// Schema version of this contract. v1 had no such method;
    /// v2 returns 2.
    pub fn get_version(&self) -> u32 {
        2
    }

    pub fn get_invoice(&self, id: u64) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn list_invoices(&self, from_index: u64, limit: u64) -> Vec<Invoice> {
        let mut out = Vec::new();
        let end = core::cmp::min(
            from_index.saturating_add(limit),
            self.next_invoice_id,
        );
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
        self.open_pending_count.get(&account_id).copied().unwrap_or(0)
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
    fn set_context_with_balance(
        predecessor: AccountId,
        balance_yocto: u128,
        locked_yocto: u128,
    ) {
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
    fn signed_meta_args(
        seller: AccountId,
        client: AccountId,
        amount: u128,
        description: &str,
        counter: u64,
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
            "twinnear:create_invoice|{}|{}|{}|{}|{}|{}",
            seller, client, amount, description, counter, nonce_b64
        );
        let mut payload = Vec::new();
        payload.extend_from_slice(&(message.len() as u32).to_le_bytes());
        payload.extend_from_slice(message.as_bytes());
        payload.extend_from_slice(&nonce_bytes);
        let recipient = "twinnear.testnet";
        payload.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        payload.extend_from_slice(recipient.as_bytes());
        payload.push(0);
        let sig = signing.sign(&payload);
        (B64.encode(sig.to_bytes()), public_key, nonce_b64)
    }

    #[test]
    fn create_invoice_works() {
        let mut c = setup(alice());
        let id = c.create_invoice(bob(), U128(1_000), "design".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "design".to_string(), None, Currency::Near, vec![], 0);
        assert_eq!(c.get_invoice(1).unwrap().due_date, None);
    }

    #[test]
    #[should_panic(expected = "due_days must be between 1 and 90")]
    fn create_invoice_rejects_bad_due_days() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "x".to_string(), Some(0), Currency::Near, vec![], 0);
    }

    #[test]
    #[should_panic(expected = "due_days must be between 1 and 90")]
    fn create_invoice_rejects_due_days_over_90() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "x".to_string(), Some(91), Currency::Near, vec![], 0);
    }

    #[test]
    #[should_panic(expected = "0.01 NEAR storage deposit")]
    fn create_invoice_requires_storage_deposit() {
        let mut c = setup(alice());
        set_predecessor_no_deposit(alice());
        c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
    }

    #[test]
    #[should_panic(expected = "seller cannot invoice themselves")]
    fn create_invoice_rejects_self_invoice() {
        let mut c = setup(alice());
        c.create_invoice(alice(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
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
        c.set_policy(U128(500), vec![], U128(0));
        set_predecessor(alice());
        c.create_invoice(bob(), U128(1_000), "too big".to_string(), None, Currency::Near, vec![], 0);
    }

    #[test]
    #[should_panic(expected = "seller is not on the client allowlist")]
    fn policy_allowlist_enforced() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![carol()], U128(0));
        set_predecessor(alice());
        c.create_invoice(bob(), U128(100), "not allowed".to_string(), None, Currency::Near, vec![], 0);
    }

    #[test]
    fn policy_allowlist_allows_listed_seller() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![alice()], U128(0));
        set_predecessor(alice());
        let id = c.create_invoice(bob(), U128(100), "ok".to_string(), None, Currency::Near, vec![], 0);
        assert_eq!(id, 1);
    }

    #[test]
    fn set_policy_dedups_allowlist() {
        let mut c = setup(bob());
        c.set_policy(U128(0), vec![alice(), alice(), carol()], U128(0));
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
        c.set_policy(U128(0), sellers, U128(0));
    }

    #[test]
    fn pay_release_flow_with_callback() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(contract_acct());
        let _promise = c.rescue_escrow(1, carol());
    }

    #[test]
    fn cancel_invoice_flow() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "typo".to_string(), None, Currency::Near, vec![], 0);
        c.cancel_invoice(1);
        assert_eq!(c.get_invoice(1).unwrap().status, InvoiceStatus::Cancelled);
        assert_eq!(c.get_open_invoice_count(alice()), 0);
    }

    #[test]
    #[should_panic(expected = "only a pending invoice can be cancelled")]
    fn cancel_paid_invoice_rejected() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(alice());
        c.cancel_invoice(1);
    }

    #[test]
    fn dispute_blocks_release_until_withdrawn() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
            c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
        }));
        assert!(refused.is_err());
        // Same total, less locked: liquid 0.15 NEAR >= 0.1 reserve.
        set_context_with_balance(alice(), 25 * NEAR / 100, 10 * NEAR / 100);
        let id = c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
        assert_eq!(id, 1);
    }

    #[test]
    #[should_panic(expected = "dispute reason must not be empty")]
    fn open_dispute_rejects_empty_reason() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
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
        c.create_invoice(bob(), U128(1_000), "work".to_string(), Some(14), Currency::Near, vec![], 0);
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_time(bob(), 13 * ONE_DAY_NS);
        let _promise = c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "invoice has no due date")]
    fn claim_refund_without_due_date_rejected() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        set_predecessor(bob());
        let _promise = c.claim_refund(1);
    }

    #[test]
    #[should_panic(expected = "amount exceeds client spend-guard limit")]
    fn pay_rechecks_policy_at_payment_time() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "work".to_string(), None, Currency::Near, vec![], 0);
        // Client sets a stricter policy AFTER the invoice was created.
        set_predecessor(bob());
        c.set_policy(U128(500), vec![], U128(0));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
    }

    #[test]
    fn daily_cap_enforced_and_resets_next_day() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "a".to_string(), None, Currency::Near, vec![], 0);
        c.create_invoice(bob(), U128(1_000), "b".to_string(), None, Currency::Near, vec![], 0);
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(1_500));
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
        c.create_invoice(bob(), U128(1_000), "a".to_string(), None, Currency::Near, vec![], 0);
        set_predecessor(bob());
        c.set_policy(U128(0), vec![], U128(5_000));
        pay_invoice_as(&mut c, 1, bob(), 1_000);
        // Edit the settings: daily accounting must survive.
        set_predecessor(bob());
        c.set_policy(U128(2_000), vec![], U128(5_000));
        let policy = c.get_policy(bob()).unwrap();
        assert_eq!(policy.daily_spent, U128(1_000));
        assert_eq!(policy.max_amount, U128(2_000));
    }

    #[test]
    fn pending_invoice_cap_50() {
        let mut c = setup(alice());
        for _ in 0..50 {
            set_predecessor(alice());
            c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
        }
        assert_eq!(c.get_open_invoice_count(alice()), 50);
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create_invoice(bob(), U128(1_000), "one too many".to_string(), None, Currency::Near, vec![], 0);
        }));
        assert!(over.is_err());
        // Cancelling one frees a slot.
        c.cancel_invoice(1);
        let id = c.create_invoice(bob(), U128(1_000), "fits now".to_string(), None, Currency::Near, vec![], 0);
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
        );
        assert_eq!(id, 1);
        assert_eq!(c.get_meta_nonce(alice()), 1);
        assert_eq!(c.get_relayer(), Some(relayer_acct()));
        assert_eq!(c.get_invoice(1).unwrap().due_date, Some(14 * ONE_DAY_NS));
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
        c.create_invoice(bob(), U128(1_000), "cross-chain".to_string(), None, Currency::Near, vec![], 0);
        c.confirm_external_payment(
            1,
            "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string(),
        );
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
        c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
        c.confirm_external_payment(1, "0xabc".to_string());
    }

    #[test]
    #[should_panic(expected = "only the seller can confirm external payment")]
    fn confirm_external_payment_seller_only() {
        let mut c = setup(alice());
        c.create_invoice(bob(), U128(1_000), "x".to_string(), None, Currency::Near, vec![], 0);
        set_predecessor(bob());
        c.confirm_external_payment(
            1,
            "0x67BccC623Fd586FA3fE6D4D2aBcA6ab0bEd1C8de".to_string(),
        );
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
        let items = vec![
            line_item("Design", 2, 1_000),
            line_item("Testing", 3, 500),
        ];
        // subtotal = 2*1000 + 3*500 = 3500; tax 10% = 350; total = 3850.
        let id = c.create_invoice(
            bob(),
            U128(3_850),
            "work".to_string(),
            None,
            Currency::Near,
            items,
            1000,
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
        );
    }

    #[test]
    fn create_invoice_usdc_skips_max_amount_but_keeps_allowlist() {
        // Client caps NEAR invoices at 500 yocto and allowlists alice.
        // A USDC invoice of 25.00 USDC (25_000_000 micro-USDC) is far
        // above the NEAR cap, but the cap is in a different unit and
        // must not apply; the allowlist still does.
        let mut c = setup(bob());
        c.set_policy(U128(500), vec![alice()], U128(0));
        set_predecessor(alice());
        let id = c.create_invoice(
            bob(),
            U128(25_000_000),
            "usdc work".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
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
        );
        pay_invoice_as(&mut c, 1, bob(), 25_000_000);
    }

    /// Write the exact v1 state that is live on twinnear.testnet into
    /// mock storage: owner twinnear.testnet, next id 2, one invoice
    /// (#1, TW-2026-0001, seller twinnear.testnet, client
    /// 0xward.testnet, 0.05 NEAR, Pending, created
    /// 1794021148914561684, due 1795230748914561684).
    fn write_v1_state_with_live_invoice_1() {
        let mut invoices: LookupMap<u64, OldInvoice> = LookupMap::new(b"i");
        invoices.insert(
            1,
            OldInvoice {
                id: 1,
                seller: contract_acct(),
                client: "0xward.testnet".parse().unwrap(),
                amount: U128(50_000_000_000_000_000_000_000),
                description: "Design work, Framework, Testing".to_string(),
                status: InvoiceStatus::Pending,
                released: false,
                created_at: 1_794_021_148_914_561_684,
                paid_at: None,
                external_ref: None,
                due_date: Some(1_795_230_748_914_561_684),
                disputed: false,
                dispute_reason: None,
            },
        );
        let old = OldContract {
            owner: contract_acct(),
            next_invoice_id: 2,
            invoices,
            policies: LookupMap::new(b"p"),
            relayer: None,
            meta_nonces: LookupMap::new(b"m"),
            pending_transfers: LookupMap::new(b"t"),
            failed_transfers: LookupMap::new(b"f"),
            open_pending_count: LookupMap::new(b"o"),
            total_escrowed: 0,
            pending_owner: None,
        };
        env::state_write(&old);
    }

    #[test]
    fn migrate_v1_state_with_live_invoice_1() {
        set_predecessor(contract_acct());
        write_v1_state_with_live_invoice_1();
        let mut c = Contract::migrate();
        assert_eq!(c.get_version(), 2);
        assert_eq!(c.get_owner(), contract_acct());
        assert_eq!(c.get_invoice_count(), 1);
        let inv = c.get_invoice(1).unwrap();
        // Every v1 field identical to the live invoice #1.
        assert_eq!(inv.id, 1);
        assert_eq!(inv.seller, contract_acct());
        assert_eq!(inv.client, "0xward.testnet".parse::<AccountId>().unwrap());
        assert_eq!(inv.amount, U128(50_000_000_000_000_000_000_000));
        assert_eq!(inv.description, "Design work, Framework, Testing");
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert!(!inv.released);
        assert_eq!(inv.created_at, 1_794_021_148_914_561_684);
        assert_eq!(inv.paid_at, None);
        assert_eq!(inv.external_ref, None);
        assert_eq!(inv.due_date, Some(1_795_230_748_914_561_684));
        assert!(!inv.disputed);
        assert_eq!(inv.dispute_reason, None);
        // New v2 fields.
        assert_eq!(inv.currency, Currency::Near);
        assert!(inv.items.is_empty());
        assert_eq!(inv.tax_rate_bps, 0);
        assert_eq!(inv.subtotal, U128(50_000_000_000_000_000_000_000));
        assert_eq!(inv.tax_amount, U128(0));
        // New invoices work after migration (next id is 2): line
        // items + tax, then a USDC invoice.
        set_predecessor(alice());
        let id = c.create_invoice(
            bob(),
            U128(220),
            "post-migrate".to_string(),
            None,
            Currency::Near,
            vec![line_item("A", 2, 100)],
            1000,
        );
        assert_eq!(id, 2);
        let id2 = c.create_invoice(
            bob(),
            U128(10_000_000),
            "usdc".to_string(),
            None,
            Currency::Usdc,
            vec![],
            0,
        );
        assert_eq!(id2, 3);
        assert_eq!(c.get_invoice_count(), 3);
    }

    #[test]
    #[should_panic(expected = "only the owner can migrate")]
    fn migrate_rejects_non_owner() {
        set_predecessor(alice());
        write_v1_state_with_live_invoice_1();
        Contract::migrate();
    }

    #[test]
    fn migrate_twice_panics_without_damaging_state() {
        set_predecessor(contract_acct());
        write_v1_state_with_live_invoice_1();
        let c = Contract::migrate();
        assert_eq!(c.get_version(), 2);
        // End of the first migrate "call": dropping the returned
        // contract flushes its maps to storage, exactly as the
        // on-chain wrapper does at the end of a transaction. Only now
        // do the v2 invoice bytes actually land in storage — without
        // this drop the second migrate would still see v1 bytes.
        drop(c);
        // Second migrate must panic: a v2 invoice no longer decodes
        // as OldInvoice (Borsh rejects the trailing bytes).
        let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Contract::migrate();
        }));
        assert!(second.is_err());
        // State undamaged: the contract still reads back from storage
        // with invoice #1 intact.
        let c2: Contract = env::state_read().expect("state should still exist");
        let inv = c2.get_invoice(1).unwrap();
        assert_eq!(inv.amount, U128(50_000_000_000_000_000_000_000));
        assert_eq!(inv.description, "Design work, Framework, Testing");
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert_eq!(inv.currency, Currency::Near);
        assert_eq!(c2.get_invoice_count(), 1);
        assert_eq!(c2.get_owner(), contract_acct());
        assert_eq!(c2.get_version(), 2);
    }
}
