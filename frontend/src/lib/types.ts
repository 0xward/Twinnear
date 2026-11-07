/** Types mirroring the Twinnear contract (contract/src/lib.rs). */

export type InvoiceStatus = "Pending" | "Paid" | "Refunded" | "Cancelled";

export interface Invoice {
  id: number;
  seller: string;
  client: string;
  /** Amount in yoctoNEAR, as a decimal string. */
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
