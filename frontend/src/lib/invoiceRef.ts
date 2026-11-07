/** Human-readable invoice reference, e.g. `TW-2026-0001`.
 * The on-chain id is still the source of truth; this is only the
 * display number a bookkeeper (and a client) can quote in an email.
 * Year comes from the invoice's creation timestamp. */
export function invoiceRef(inv: {
  id: number;
  created_at: number;
}): string {
  const year = new Date(Math.floor(inv.created_at / 1_000_000)).getUTCFullYear();
  return `TW-${year}-${String(inv.id).padStart(4, "0")}`;
}

/** Reminder text a seller can paste into an email or chat. */export function buildReminderText(
  ref: string,
  amountNear: string,
  description: string,
  payUrl: string,
): string {
  const what = description ? ` for ${description}` : "";
  return (
    `Invoice ${ref}: ${amountNear} NEAR${what}.\n` +
    `You can pay it here: ${payUrl}\n` +
    `Thank you! Twinnear`
  );
}
