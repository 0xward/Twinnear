/**
 * Verified on-chain transaction hashes for invoice #1 (TW-2026-0001),
 * the first real invoice on the contract. Single source of truth for
 * the About page and the public invoice view. Verified 7 Nov 2026
 * via RPC EXPERIMENTAL_tx_status: all three succeeded, receiver
 * twinnear.testnet, FunctionCall. The create call returned id 1.
 */
export const INVOICE_1_TX = {
  create: "14nev3LUrvanzZvVQc25373q85NCeKD7Ee5PEQ6ps8yP",
  pay: "GWzwgrctqSBdYhG79LSo5BM1RwU8RxQBBVyyT7bpQTLA",
  release: "ARUyJbgZTvdgTtR58p2F8PPTDKB977TjpLMyweziwRNJ",
} as const;

/**
 * Explorer links for the on-chain steps of one invoice. Only invoice
 * #1 has recorded hashes; other invoices link to the contract account
 * instead, where every transaction is listed.
 */
export function txLinksFor(id: number): { label: string; hash: string }[] {
  if (id !== 1) return [];
  return [
    { label: "Created", hash: INVOICE_1_TX.create },
    { label: "Paid", hash: INVOICE_1_TX.pay },
    { label: "Released", hash: INVOICE_1_TX.release },
  ];
}
