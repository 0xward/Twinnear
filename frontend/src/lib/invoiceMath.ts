/**
 * Line-item arithmetic — the frontend mirror of the contract's v2
 * math (contract/src/lib.rs `create_invoice`):
 *
 *   subtotal = Σ qty * unit_price
 *   tax      = subtotal * tax_rate_bps / 10000   (integer division)
 *   total    = subtotal + tax
 *
 * All in BigInt, in the invoice currency's smallest unit, so the
 * preview the seller sees is exactly the total the contract asserts
 * (`amount must equal line-item total (subtotal + tax)`).
 */
import type { LineItem } from "./types";

export interface InvoiceTotals {
  subtotal: string;
  taxAmount: string;
  total: string;
}

export function computeInvoiceTotal(
  items: LineItem[],
  taxRateBps: number,
): InvoiceTotals {
  let subtotal = 0n;
  for (const item of items) {
    subtotal += BigInt(item.quantity) * BigInt(item.unit_price);
  }
  const taxAmount = (subtotal * BigInt(taxRateBps)) / 10_000n;
  return {
    subtotal: subtotal.toString(),
    taxAmount: taxAmount.toString(),
    total: (subtotal + taxAmount).toString(),
  };
}

/** A line item as edited in the form (strings from inputs). */
export interface LineItemDraft {
  description: string;
  quantity: string;
  /** Unit price in display units (NEAR or USDC, per currency). */
  unitPrice: string;
}

export function draftIsEmpty(d: LineItemDraft): boolean {
  return (
    d.description.trim() === "" &&
    d.quantity.trim() === "" &&
    d.unitPrice.trim() === ""
  );
}

/**
 * Validate one draft row against the contract's limits and parse it
 * into a contract LineItem. Returns an error message (not a throw)
 * so the form can show it next to the row.
 */
export function parseLineItemDraft(
  d: LineItemDraft,
  rowNo: number,
  parseUnitPrice: (value: string) => string | null,
): { item?: LineItem; error?: string } {
  const descBytes = new TextEncoder().encode(d.description.trim()).length;
  if (descBytes === 0) {
    return { error: `Row ${rowNo}: add a description.` };
  }
  if (descBytes > 200) {
    return {
      error: `Row ${rowNo}: description is ${descBytes} bytes — the contract allows at most 200 bytes per line item.`,
    };
  }
  if (!/^\d+$/.test(d.quantity.trim())) {
    return { error: `Row ${rowNo}: quantity must be a whole number.` };
  }
  const qty = Number(d.quantity.trim());
  if (qty < 1 || qty > 10000) {
    return { error: `Row ${rowNo}: quantity must be between 1 and 10,000.` };
  }
  const unitPrice = parseUnitPrice(d.unitPrice.trim());
  if (!unitPrice || BigInt(unitPrice) <= 0n) {
    return {
      error: `Row ${rowNo}: unit price must be a positive amount (e.g. 1.5).`,
    };
  }
  return {
    item: {
      description: d.description.trim(),
      quantity: qty,
      unit_price: unitPrice,
    },
  };
}
