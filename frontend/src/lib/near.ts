/**
 * NEAR connection layer: Wallet Selector (Meteor + OKX + Intear +
 * WalletConnect) for signing,
 * near-api-js JsonRpcProvider for read-only view calls.
 *
 * No keys are ever handled here — signing happens inside the user's wallet.
 *
 * Bundle note: the wallet-selector packages and near-api-js are large
 * (~1.2 MB combined). They are loaded with dynamic import() only when
 * actually needed (first view call / first wallet interaction), so the
 * initial JS chunk stays small. The NEAR amount helpers below are
 * implemented locally with BigInt instead of near-api-js's formatter,
 * so formatting stays synchronous and dependency-free.
 *
 * QA fixes in this file:
 * - H-07: `setPolicy` throws on an unparseable amount instead of
 *   silently storing "no limit".
 * - M-02: `confirmExternalPayment` validates the reference format.
 * - M-05: `getAccountBalance` / `accountExists` for pre-flight checks,
 *   `friendlyError` maps raw wallet/RPC errors to plain language.
 * - M-06: contract calls return their result so pages can show the
 *   tx hash + explorer link instead of reloading immediately.
 * - L-01: `onAccountChange` subscribes to wallet-selector account
 *   changes; `signOut` never throws an unhandled rejection.
 * - L-03/L-05: strict account validation, `getInvoiceCount`,
 *   `listAllInvoices` (paged, no silent 100-cap).
 */
import type { providers } from "near-api-js";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { CONTRACT_ID, NETWORK_ID, RPC_URL } from "./config";
import type { Invoice, Milestone, MilestoneInput, Policy, SplitShare, SplitShareInput, UsdcPolicy } from "./types";

let selectorPromise: Promise<WalletSelector> | null = null;
let modal: WalletSelectorModal | null = null;
let provider: providers.JsonRpcProvider | null = null;

async function loadSelectorDeps() {
  const [
    { setupWalletSelector },
    { setupMeteorWallet },
    { setupOKXWallet },
    { setupIntearWallet },
    { setupWalletConnect },
  ] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/okx-wallet"),
    import("@near-wallet-selector/intear-wallet"),
    import("@near-wallet-selector/wallet-connect"),
  ]);
  return {
    setupWalletSelector,
    setupMeteorWallet,
    setupOKXWallet,
    setupIntearWallet,
    setupWalletConnect,
  };
}

export function getSelector(): Promise<WalletSelector> {
  if (!selectorPromise) {
    selectorPromise = loadSelectorDeps().then(
      ({
        setupWalletSelector,
        setupMeteorWallet,
        setupOKXWallet,
        setupIntearWallet,
        setupWalletConnect,
      }) =>
        setupWalletSelector({
          network: NETWORK_ID,
          modules: [
            setupMeteorWallet(),
            setupOKXWallet(),
            setupIntearWallet(),
            setupWalletConnect({
              projectId: "ea5f0fd20b26896045774900b7294b1a",
              metadata: {
                name: "Twinnear",
                description: "Gasless freelancer invoicing on NEAR",
                url: "https://twinnear.vercel.app",
                icons: ["https://twinnear.vercel.app/logo.svg"],
              },
              chainId: "near:testnet",
            }),
          ],
        }),
    );
  }
  return selectorPromise;
}

export async function getModal(): Promise<WalletSelectorModal> {
  if (!modal) {
    const selector = await getSelector();
    const { setupModal } = await import("@near-wallet-selector/modal-ui");
    modal = setupModal(selector, { contractId: CONTRACT_ID });
  }
  return modal;
}

export async function openWalletModal(): Promise<void> {
  const m = await getModal();
  m.show();
}

/**
 * Warm up the wallet modal (selector modules + modal UI chunk) in the
 * background, so the first "Connect wallet" click shows the modal
 * immediately instead of waiting on chunk downloads with no feedback.
 *
 * Diagnosis of the slow first click: `openWalletModal` awaited
 * `getSelector()` (five wallet-selector chunks downloaded in parallel,
 * WalletConnect the heaviest) AND `getModal()` (the modal-ui chunk),
 * then `setupWalletSelector` initialised all four wallet modules —
 * all of it after the click, with the button showing nothing at all
 * meanwhile. The chunks are already cached on the second click, which
 * is why only the first click felt slow. Fire-and-forget: a failure
 * here is ignored and the click path retries the same load.
 */
export function warmWalletModal(): void {
  getModal().catch(() => {});
}

export async function getSignedInAccount(): Promise<string | null> {
  const selector = await getSelector();
  const state = selector.store.getState();
  return state.accounts[0]?.accountId ?? null;
}

/** Subscribe to wallet account changes (L-01). Returns an unsubscribe. */
export async function onAccountChange(
  cb: (accountId: string | null) => void,
): Promise<() => void> {
  const selector = await getSelector();
  const sub = selector.store.observable.subscribe((state) => {
    cb(state.accounts[0]?.accountId ?? null);
  });
  return () => sub.unsubscribe();
}

export async function signOut(): Promise<void> {
  try {
    const selector = await getSelector();
    const wallet = await selector.wallet();
    await wallet.signOut();
  } catch {
    // No wallet / already signed out — signing out is idempotent
    // from the UI's point of view; never an unhandled rejection.
  }
}

async function getProvider(): Promise<providers.JsonRpcProvider> {
  if (!provider) {
    const { providers: nearProviders } = await import("near-api-js");
    provider = new nearProviders.JsonRpcProvider({ url: RPC_URL });
  }
  return provider;
}

/** Minimal raw JSON-RPC call (view_account / view_code) with a timeout. */
async function rpcQuery<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "twinnear-ui", method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: T;
    error?: { message?: string; data?: unknown };
  };
  if (body.error) {
    throw new Error(
      `RPC ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  }
  if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

async function viewCall(
  methodName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rpc = await getProvider();
  const res = (await rpc.query({
    request_type: "call_function",
    account_id: CONTRACT_ID,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args)),
    finality: "final",
  })) as unknown as { result: number[] };
  const text = new TextDecoder().decode(new Uint8Array(res.result));
  return JSON.parse(text);
}

export interface AccountBalance {
  /** Total balance, yoctoNEAR string. */
  totalYocto: string;
  /** Locked (storage-staked) balance, yoctoNEAR string. */
  lockedYocto: string;
  /** Spendable balance, yoctoNEAR string. */
  availableYocto: string;
}

/** Live balance of any account (M-05 pre-flight checks). */
export async function getAccountBalance(
  accountId: string,
): Promise<AccountBalance> {
  const res = await rpcQuery<{
    amount: string;
    locked: string;
  }>("query", {
    request_type: "view_account",
    account_id: accountId,
    finality: "final",
  });
  const total = BigInt(res.amount);
  const locked = BigInt(res.locked);
  return {
    totalYocto: res.amount,
    lockedYocto: res.locked,
    availableYocto: (total - locked).toString(),
  };
}

/** True when the account exists on this network (L-03). */
export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpcQuery("query", {
      request_type: "view_account",
      account_id: accountId,
      finality: "final",
    });
    return true;
  } catch (err) {
    // Only a "does not exist" answer means the account is missing.
    // A network failure, timeout, or any other RPC error is NOT proof
    // the account is missing: rethrow it so the caller reports a
    // network problem instead of wrongly claiming the account
    // does not exist. (A real case: a slow mobile connection timed
    // out the view_account call for 0xward.testnet, an account that
    // exists, and the UI told the user it did not exist.)
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      msg.includes("does not exist") ||
      msg.includes("doesn't exist") ||
      msg.includes("account not found") ||
      msg.includes("unknown account")
    ) {
      return false;
    }
    throw err;
  }
}

export async function listInvoices(
  fromIndex = 1,
  limit = 100,
): Promise<Invoice[]> {
  const raw = (await viewCall("list_invoices", {
    from_index: fromIndex,
    limit,
  })) as Invoice[];
  return raw.map(normalizeInvoice);
}

export async function getInvoice(id: number): Promise<Invoice | null> {
  const raw = (await viewCall("get_invoice", { id })) as Invoice | null;
  return raw === null ? null : normalizeInvoice(raw);
}

/**
 * Fill in the v2 fields for invoices read from a v1 contract (or any
 * view response that predates them): a v1 invoice is a single-line
 * NEAR invoice with no tax. Without this, `inv.currency` would be
 * undefined on the live v1 contract and every currency-aware page
 * would break before the v2 upgrade lands.
 */
export function normalizeInvoice(raw: Invoice): Invoice {
  const currency = raw.currency ?? "Near";
  const items = raw.items ?? [];
  const taxRateBps = raw.tax_rate_bps ?? 0;
  const subtotal = raw.subtotal ?? raw.amount;
  const taxAmount = raw.tax_amount ?? "0";
  return {
    ...raw,
    currency,
    items,
    tax_rate_bps: taxRateBps,
    subtotal,
    tax_amount: taxAmount,
  };
}

/** True when the invoice is denominated in USDC (micro-USDC). */
export function isUsdcInvoice(inv: Invoice): boolean {
  return (inv.currency ?? "Near") === "Usdc";
}

/** Display symbol for an invoice's currency (plain text, for
 *  share text / CSV — on-screen amounts use <CurrencyIcon/>). */
export function currencySymbol(currency: string): string {
  return currency === "Usdc" ? "USDC" : "NEAR";
}

/**
 * Format an invoice total in its own currency, e.g. "1.5 NEAR" or
 * "12.34 USDC". Plain text only, for share text and other
 * non-JSX contexts — on-screen amounts use <InvoiceAmount/> so the
 * official logo is shown. Amounts are always shown in their native
 * unit — never convert USDC micro-units as if they were yoctoNEAR.
 */
export function formatInvoiceAmount(inv: Invoice): string {
  return isUsdcInvoice(inv)
    ? `${formatUsdc(inv.amount)} USDC`
    : `${formatNear(inv.amount)} NEAR`;
}

/** Contract schema version (v2 method; v1 has no such method). */
export async function getVersion(): Promise<number | null> {
  try {
    return (await viewCall("get_version", {})) as number;
  } catch {
    return null;
  }
}

export async function getPolicy(accountId: string): Promise<Policy | null> {
  return (await viewCall("get_policy", { account_id: accountId })) as
    | Policy
    | null;
}

/** USDC spend-guard policy of an account (v4), if one is set. */
export async function getUsdcPolicy(
  accountId: string,
): Promise<UsdcPolicy | null> {
  return (await viewCall("get_usdc_policy", { account_id: accountId })) as
    | UsdcPolicy
    | null;
}

export async function getOwner(): Promise<string> {
  return (await viewCall("get_owner", {})) as string;
}

export async function getMetaNonce(accountId: string): Promise<number> {
  return (await viewCall("get_meta_nonce", {
    account_id: accountId,
  })) as number;
}

export async function getInvoiceCount(): Promise<number> {
  return (await viewCall("get_invoice_count", {})) as number;
}

export async function getOpenInvoiceCount(
  accountId: string,
): Promise<number> {
  return (await viewCall("get_open_invoice_count", {
    account_id: accountId,
  })) as number;
}

export async function getTotalEscrowed(): Promise<string> {
  return (await viewCall("get_total_escrowed", {})) as string;
}

/**
 * All invoices, paged through the contract (L-05). The old hardcoded
 * `listInvoices(1, 100)` silently dropped invoice #101+ from the
 * Dashboard, the list, and the CSV.
 */
export async function listAllInvoices(): Promise<{
  invoices: Invoice[];
  total: number;
}> {
  const total = await getInvoiceCount();
  const invoices: Invoice[] = [];
  const PAGE = 100;
  for (let from = 1; from <= total; from += PAGE) {
    const page = await listInvoices(from, PAGE);
    invoices.push(...page);
    if (page.length < PAGE) break;
  }
  return { invoices, total };
}

/** Seller attests an off-chain (1Click) settlement and closes the invoice. */
export async function confirmExternalPayment(
  id: number,
  reference: string,
): Promise<unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(reference) && !/^0x[0-9a-fA-F]{64}$/.test(reference)) {
    throw new Error(
      "Reference must be a 1Click deposit address (0x + 40 hex chars) or an origin-chain tx hash (0x + 64 hex chars).",
    );
  }
  return callContract("confirm_external_payment", { id, reference }, "0");
}

const GAS_100_TGAS = "100000000000000"; // wallet-selector v8 expects strings

async function callContract(
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: string,
): Promise<unknown> {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName,
          args,
          gas: GAS_100_TGAS,
          deposit: depositYocto,
        },
      },
    ],
  });
}

/** Tx hash from a wallet `signAndSendTransaction` result, if present. */
export function extractTxHash(res: unknown): string | null {
  const r = res as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
  } | null;
  return r?.transaction?.hash ?? r?.transaction_outcome?.id ?? null;
}

/**
 * Decode the u64 return value of a change-method call (e.g. the new
 * invoice id from `create_invoice`), if the wallet result carries it
 * (`status.SuccessValue`, base64 JSON). Best-effort only: wallets
 * differ in what they return, so callers must not depend on it —
 * NewInvoice falls back to listing the seller's invoices.
 */
export function extractReturnU64(res: unknown): number | null {
  const r = res as { status?: { SuccessValue?: string } } | null;
  const b64 = r?.status?.SuccessValue;
  if (!b64) return null;
  try {
    const n = JSON.parse(atob(b64));
    return typeof n === "number" && Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** One-time, non-refundable storage deposit for a direct create (H-06). */
export const STORAGE_DEPOSIT_YOCTO = "10000000000000000000000"; // 0.01 NEAR
export const STORAGE_DEPOSIT_NEAR = "0.01";

/**
 * Create an invoice for `client`, attaching the 0.01 NEAR storage
 * deposit (H-06). `dueDays`: 1–90, or null for no deadline.
 *
 * v2 signature (contract/src/lib.rs): `amount` is the TOTAL
 * (subtotal + tax) in the invoice currency's smallest unit — yoctoNEAR
 * for Near (use `parseNearAmount`), micro-USDC for Usdc (use
 * `parseUsdcAmount`). `items` is [] for a single-line invoice and
 * `taxRateBps` must be 0 then; with line items the contract asserts
 * amount == subtotal + tax. The caller computes the total first
 * (see `computeInvoiceTotal` in lib/invoiceMath.ts).
 *
 * v5: `milestones` and `splits` are the last two args (contract
 * `create_invoice`). NEAR only: the contract rejects them for USDC
 * invoices. Milestone amounts are yoctoNEAR strings and must sum
 * exactly to `amount`; split shares are basis points summing to
 * exactly 10000. Empty arrays = a plain invoice, exactly as before.
 */
export async function createInvoice(
  client: string,
  amountSmallestUnit: string,
  description: string,
  dueDays: number | null,
  currency: "Near" | "Usdc" = "Near",
  items: import("./types").LineItem[] = [],
  taxRateBps = 0,
  milestones: MilestoneInput[] = [],
  splits: SplitShareInput[] = [],
): Promise<unknown> {
  return callContract(
    "create_invoice",
    {
      client,
      amount: amountSmallestUnit,
      description,
      due_days: dueDays,
      currency,
      items,
      tax_rate_bps: taxRateBps,
      milestones,
      splits,
    },
    STORAGE_DEPOSIT_YOCTO,
  );
}

/** Funded milestones of an invoice (v5 view). Empty = plain invoice. */
export async function getMilestones(invoiceId: number): Promise<Milestone[]> {
  return (await viewCall("get_milestones", {
    invoice_id: invoiceId,
  })) as Milestone[];
}

/** Programmable split recipients of an invoice (v5 view). Empty = 100% to the seller. */
export async function getSplits(invoiceId: number): Promise<SplitShare[]> {
  return (await viewCall("get_splits", {
    invoice_id: invoiceId,
  })) as SplitShare[];
}

/** Seller marks one milestone's work as done (v5). Invoice must be Paid. */
export async function submitWork(
  invoiceId: number,
  milestoneIndex: number,
): Promise<unknown> {
  return callContract(
    "submit_work",
    { invoice_id: invoiceId, milestone_index: milestoneIndex },
    "0",
  );
}

/** Client approves a submitted milestone (v5): releases its amount at once, split by the invoice splits. */
export async function approveMilestone(
  invoiceId: number,
  milestoneIndex: number,
): Promise<unknown> {
  return callContract(
    "approve_milestone",
    { invoice_id: invoiceId, milestone_index: milestoneIndex },
    "0",
  );
}

/** Client sends a submitted milestone back for changes (v5). */
export async function requestChanges(
  invoiceId: number,
  milestoneIndex: number,
  reason: string,
): Promise<unknown> {
  return callContract(
    "request_changes",
    { invoice_id: invoiceId, milestone_index: milestoneIndex, reason },
    "0",
  );
}

/** Seller claims a submitted milestone after the 14-day window (v5). */
export async function claimMilestone(
  invoiceId: number,
  milestoneIndex: number,
): Promise<unknown> {
  return callContract(
    "claim_milestone",
    { invoice_id: invoiceId, milestone_index: milestoneIndex },
    "0",
  );
}

export async function payInvoice(
  id: number,
  amountYocto: string,
): Promise<unknown> {
  return callContract("pay_invoice", { id }, amountYocto);
}

export async function releaseInvoice(id: number): Promise<unknown> {
  return callContract("release_invoice", { id }, "0");
}

export async function refundInvoice(id: number): Promise<unknown> {
  return callContract("refund_invoice", { id }, "0");
}

export async function cancelInvoice(id: number): Promise<unknown> {
  return callContract("cancel_invoice", { id }, "0");
}

export async function openDispute(
  id: number,
  reason: string,
): Promise<unknown> {
  return callContract("open_dispute", { id, reason }, "0");
}

export async function withdrawDispute(id: number): Promise<unknown> {
  return callContract("withdraw_dispute", { id }, "0");
}

export async function claimRefund(id: number): Promise<unknown> {
  return callContract("claim_refund", { id }, "0");
}

/**
 * Set (or replace) the caller's spend-guard policy (H-07): an
 * unparseable amount THROWS instead of silently becoming "no limit".
 * Empty string = no limit (0). `maxTotalPerDayNear` caps escrow
 * payments per UTC day; empty = no cap. v4: `usdcMaxAmount` /
 * `usdcDailyCap` set the USDC caps (micro-USDC) in the same call;
 * empty = no cap.
 */
export async function setPolicy(
  maxAmountNear: string,
  allowedSellers: string[],
  maxTotalPerDayNear: string,
  usdcMaxAmount: string,
  usdcDailyCap: string,
): Promise<unknown> {
  const maxAmount = parseOptionalNear(maxAmountNear, "Max amount");
  const maxTotal = parseOptionalNear(maxTotalPerDayNear, "Max total per day");
  const usdcMax = parseOptionalUsdc(usdcMaxAmount, "Max USDC amount");
  const usdcDaily = parseOptionalUsdc(usdcDailyCap, "Max USDC total per day");
  return callContract(
    "set_policy",
    {
      max_amount: maxAmount,
      allowed_sellers: allowedSellers,
      max_total_per_day: maxTotal,
      usdc_max_amount: usdcMax,
      usdc_daily_cap: usdcDaily,
    },
    "0",
  );
}

function parseOptionalNear(value: string, label: string): string {
  const v = value.trim();
  if (v === "" || v === "0") return "0";
  const parsed = parseNearAmount(v);
  if (!parsed) {
    throw new Error(
      `${label} "${value}" is not a plain decimal amount. Use a number like 1.5 (no exponents, at most 24 decimal places).`,
    );
  }
  return parsed;
}

/** Like parseOptionalNear, but for USDC amounts (max 6 decimals). */
function parseOptionalUsdc(value: string, label: string): string {
  const v = value.trim();
  if (v === "" || v === "0") return "0";
  const parsed = parseUsdcAmount(v);
  if (!parsed) {
    throw new Error(
      `${label} "${value}" is not a plain decimal USDC amount. Use a number like 12.34 (no exponents, at most 6 decimal places).`,
    );
  }
  return parsed;
}

const YOCTO_PER_NEAR = 10n ** 24n;

const MICRO_PER_USDC = 1_000_000n;

/**
 * Parse a decimal USDC amount ("12.34") to micro-USDC (6 decimals).
 * Returns null for invalid input. Max 6 fractional digits — the same
 * rule as parseNearAmount, at USDC's own precision.
 */
export function parseUsdcAmount(amount: string): string | null {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 6) return null;
  const micro =
    BigInt(whole) * MICRO_PER_USDC + BigInt(frac.padEnd(6, "0") || "0");
  return micro.toString();
}

/** Strict decimal USDC amount, e.g. "12.34" — no exponents, max 6 decimals. */
export function isPlainUsdcAmount(value: string): boolean {
  const v = value.trim();
  return /^\d+(\.\d{1,6})?$/.test(v) && Number(v) > 0;
}

/** Format a micro-USDC string as a short USDC amount, e.g. "12.34". */
export function formatUsdc(micro: string): string {
  let value: bigint;
  try {
    value = BigInt(micro);
  } catch {
    return "0";
  }
  const whole = value / MICRO_PER_USDC;
  const frac = value % MICRO_PER_USDC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Format a micro-USDC string at FULL precision (no rounding, for CSV). */
export function formatUsdcFull(micro: string): string {
  let value: bigint;
  try {
    value = BigInt(micro);
  } catch {
    return "0";
  }
  const whole = value / MICRO_PER_USDC;
  const frac = value % MICRO_PER_USDC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Parse a decimal NEAR amount ("0.5") to a yoctoNEAR string.
 * Returns null for invalid input. Local BigInt implementation —
 * equivalent to near-api-js `utils.format.parseNearAmount` for the
 * plain decimal amounts this app accepts (no exponential notation).
 */
export function parseNearAmount(amount: string): string | null {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 24) return null;
  const yocto =
    BigInt(whole) * YOCTO_PER_NEAR +
    BigInt(frac.padEnd(24, "0") || "0");
  return yocto.toString();
}

/** Strict decimal amount, e.g. "1.5" or "0.0001" — no exponents. */
export function isPlainDecimalAmount(value: string): boolean {
  const v = value.trim();
  return /^\d+(\.\d{1,24})?$/.test(v) && Number(v) > 0;
}

/** Format a yoctoNEAR string as a short NEAR amount, e.g. "1.5". */
export function formatNear(yocto: string): string {
  let value: bigint;
  try {
    value = BigInt(yocto);
  } catch {
    return "0";
  }
  const whole = value / YOCTO_PER_NEAR;
  const frac = value % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  // 4 fractional digits, like near-api-js formatNearAmount(yocto, 4).
  const frac4 = (frac * 10_000n) / YOCTO_PER_NEAR;
  const fracStr = frac4.toString().padStart(4, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Format a yoctoNEAR string at FULL precision (L-06): no rounding, so
 * bookkeeping exports never lose dust (0.00001 NEAR used to export as 0).
 */
export function formatNearFull(yocto: string): string {
  let value: bigint;
  try {
    value = BigInt(yocto);
  } catch {
    return "0";
  }
  const whole = value / YOCTO_PER_NEAR;
  const frac = value % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Format a contract block timestamp (nanoseconds) as a readable date. */
export function formatDate(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString();
}

// ---- Account validation (L-03, M-05) ----

/** NEAR account name: 2–64 chars, lowercase alphanumerics, `-`/`_`/`.`. */
const ACCOUNT_RE = /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

export function isValidAccountId(accountId: string): boolean {
  return ACCOUNT_RE.test(accountId);
}

/**
 * True when the account name is well-formed AND belongs to this
 * network: on testnet an account must end in `.testnet` (a mainnet
 * `.near` account can never transact here).
 */
export function isAccountForNetwork(accountId: string): boolean {
  if (!isValidAccountId(accountId)) return false;
  return NETWORK_ID === "testnet"
    ? accountId.endsWith(".testnet")
    : !accountId.endsWith(".testnet");
}

// ---- Friendly errors (M-05) ----

/** Map raw wallet/RPC errors to plain-language messages. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("user rejected") ||
    lower.includes("rejected the transaction") ||
    lower.includes("user closed") ||
    lower.includes("user cancelled")
  ) {
    return "You rejected the transaction in your wallet. Nothing was sent.";
  }
  if (
    lower.includes("insufficient") ||
    lower.includes("not enough balance") ||
    lower.includes("lack of balance") ||
    lower.includes("doesn't have enough balance")
  ) {
    return "Not enough NEAR in your account for this transaction (amount + gas). Top up from the testnet faucet and try again.";
  }
  if (lower.includes("does not exist") || lower.includes("account not found")) {
    return "That NEAR account does not exist (yet). Check the spelling.";
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return "Could not reach the NEAR network. Check your connection and try again.";
  }
  if (lower.includes("nonce") && lower.includes("already used")) {
    return "This transaction was already submitted. Refresh the page to see the latest status.";
  }
  return msg;
}
