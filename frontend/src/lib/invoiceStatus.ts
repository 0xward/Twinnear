import type { Invoice } from "./types";

/** Human label for an invoice's state (M-02/M-03, H-03). */
export function statusLabel(invoice: Invoice): string {
  if (invoice.status === "Paid" && invoice.external_ref !== null) {
    return "Paid · external (unverified)";
  }
  if (invoice.status === "Paid" && invoice.released) return "Paid · released";
  if (invoice.status === "Paid") return "Paid · escrow";
  if (invoice.status === "Cancelled") return "Cancelled";
  if (invoice.status === "Refunded") return "Refunded";
  return "Pending";
}

/** CSS class for the status stamp. */
export function stampClass(invoice: Invoice): string {
  if (invoice.status === "Paid") return "stamp stamp-paid";
  if (invoice.status === "Refunded" || invoice.status === "Cancelled") {
    return "stamp stamp-refunded";
  }
  return "stamp stamp-pending";
}
