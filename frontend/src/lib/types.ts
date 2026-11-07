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
