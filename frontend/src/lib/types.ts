/** Types mirroring the Twinnear contract (contract/src/lib.rs, v2). */

export type InvoiceStatus = "Pending" | "Paid" | "Refunded" | "Cancelled";

/** Invoice currency (contract v2). JSON: "Near" | "Usdc". */
export type Currency = "Near" | "Usdc";

export interface LineItem {
  description: string;
  quantity: number;
  /** Unit price in the invoice currency's smallest unit
   *  (yoctoNEAR for Near, micro-USDC for Usdc), as a decimal string. */
  unit_price: string;
}

export interface Invoice {
  id: number;
  seller: string;
  client: string;
  /** TOTAL amount (subtotal + tax) in the invoice currency's smallest
   *  unit: yoctoNEAR for Near, micro-USDC (6 decimals) for Usdc. */
  amount: string;
  description: string;
  status: InvoiceStatus;
  released: boolean;
  /** Block timestamp in nanoseconds (u64). */
  created_at: number;
  paid_at: number | null;
  /** Reference for off-chain settlement (1Click deposit address or tx
   *  hash). Null for plain NEAR escrow payments. */
  external_ref: string | null;
  /** Payment deadline (block timestamp, ns). Null = no deadline. */
  due_date: number | null;
  /** True while the client disputes a paid, unreleased invoice. */
  disputed: boolean;
  /** Dispute reason (max 200 bytes). Null when undisputed. */
  dispute_reason: string | null;
  // ---- v2 fields (appended after dispute_reason in the contract) ----
  currency: Currency;
  /** Empty = single-line (legacy) invoice. */
  items: LineItem[];
  /** Tax rate in basis points, 0..=10000 (10000 = 100%). */
  tax_rate_bps: number;
  /** Sum of qty * unit_price (or = amount when items is empty). */
  subtotal: string;
  /** subtotal * tax_rate_bps / 10000 (0 when items is empty). */
  tax_amount: string;
}

export interface Policy {
  /** Max amount (yoctoNEAR) per invoice. "0" = no limit. */
  max_amount: string;
  /** Sellers allowed to charge this account. Empty = any seller. */
  allowed_sellers: string[];
  /** Max total payable via escrow per UTC day. "0" = no limit. */
  max_total_per_day: string;
  /** Amount already paid via escrow on `daily_spent_day`. */
  daily_spent: string;
  /** Day number (`block_timestamp_ns / 86_400_000_000_000`). */
  daily_spent_day: number;
}

/** USDC spend-guard policy (contract v4). Same shape as `Policy`,
 *  denominated in micro-USDC (6 decimals). */
export interface UsdcPolicy {
  /** Max amount (micro-USDC) per USDC invoice. "0" = no limit. */
  max_amount: string;
  /** Max total confirmable via external payment per UTC day. "0" = no limit. */
  max_total_per_day: string;
  /** Amount already confirmed via external payment on `daily_spent_day`. */
  daily_spent: string;
  /** Day number (`block_timestamp_ns / 86_400_000_000_000`). */
  daily_spent_day: number;
}

// ---- v5: funded milestones + programmable splits ----

/** Lifecycle of one funded milestone (contract v5). */
export type MilestoneState =
  | "Pending"
  | "Submitted"
  | "ChangesRequested"
  | "Released";

/** One funded milestone of an invoice (view `get_milestones`). */
export interface Milestone {
  /** Max 200 bytes. */
  description: string;
  /** This milestone's share of the invoice amount, yoctoNEAR. */
  amount: string;
  state: MilestoneState;
  /** Block timestamp (ns) of the current submission; null while not
   *  awaiting review. The 14-day window runs from here. */
  submitted_at: number | null;
  /** Last reason the client gave with `request_changes`; null unless
   *  the milestone is currently ChangesRequested. */
  change_reason: string | null;
}

/** A milestone as passed at invoice creation (v5). */
export interface MilestoneInput {
  description: string;
  /** YoctoNEAR, as a decimal string. */
  amount: string;
}

/** One split recipient as passed at invoice creation (v5). */
export interface SplitShareInput {
  account: string;
  /** Share in basis points, 1..=10000. All shares sum to 10000. */
  share_bps: number;
}

/** One stored split recipient (view `get_splits`). */
export interface SplitShare {
  account: string;
  share_bps: number;
}
