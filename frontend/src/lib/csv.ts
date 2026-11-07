import type { Invoice } from "./types";
import { formatNearFull, formatUsdcFull, isUsdcInvoice } from "./near";
import { invoiceRef } from "./invoiceRef";

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** One-line summary of the line items, e.g. "Design x1 @ 1.5 NEAR; QA x2 @ 0.5 NEAR". */
export function itemsSummary(inv: Invoice): string {
  if (inv.items.length === 0) return "";
  return inv.items
    .map((item) => {
      const unit = isUsdcInvoice(inv)
        ? formatUsdcFull(item.unit_price)
        : formatNearFull(item.unit_price);
      const sym = isUsdcInvoice(inv) ? "USDC" : "NEAR";
      return `${item.description} x${item.quantity} @ ${unit} ${sym}`;
    })
    .join("; ");
}

/**
 * Build a bookkeeper-friendly CSV of invoices and trigger a download.
 * Columns are stable (header first, TOTAL rows last) so the file can
 * be imported into a spreadsheet or ledger without rework.
 *
 * Amounts are in the invoice's own currency at FULL precision
 * (L-06): 0.00001 NEAR must not export as 0. `amount` is the native
 * display amount; `amount_smallest_unit` is the raw on-chain value
 * (yoctoNEAR for NEAR, micro-USDC for USDC). NEAR and USDC totals
 * are separate TOTAL rows — the two units are never added together.
 */
export function exportInvoicesCsv(invoices: Invoice[]): void {
  const header = [
    "invoice_ref",
    "id",
    "seller",
    "client",
    "currency",
    "amount",
    "amount_smallest_unit",
    "subtotal",
    "tax_amount",
    "items",
    "description",
    "status",
    "released",
    "created_at",
    "paid_at",
    "external_ref",
  ];

  const rowFor = (inv: Invoice): string[] => {
    const usdc = isUsdcInvoice(inv);
    return [
      invoiceRef(inv),
      String(inv.id),
      inv.seller,
      inv.client,
      inv.currency,
      usdc ? formatUsdcFull(inv.amount) : formatNearFull(inv.amount),
      inv.amount,
      usdc ? formatUsdcFull(inv.subtotal) : formatNearFull(inv.subtotal),
      usdc ? formatUsdcFull(inv.tax_amount) : formatNearFull(inv.tax_amount),
      itemsSummary(inv),
      inv.description,
      inv.status,
      inv.released ? "yes" : "no",
      new Date(Math.floor(inv.created_at / 1_000_000)).toISOString(),
      inv.paid_at
        ? new Date(Math.floor(inv.paid_at / 1_000_000)).toISOString()
        : "",
      inv.external_ref ?? "",
    ];
  };

  const rows = invoices.map((inv) => rowFor(inv).map(csvCell).join(","));

  const totalRow = (
    label: string,
    currency: "Near" | "Usdc",
    list: Invoice[],
  ): string => {
    const sum = (pick: (inv: Invoice) => string): bigint =>
      list.reduce((s, inv) => s + BigInt(pick(inv)), 0n);
    const amount = sum((i) => i.amount);
    const subtotal = sum((i) => i.subtotal);
    const tax = sum((i) => i.tax_amount);
    const fmt = currency === "Usdc" ? formatUsdcFull : formatNearFull;
    const cells = [
      label,
      String(list.length),
      "",
      "",
      currency,
      fmt(amount.toString()),
      amount.toString(),
      fmt(subtotal.toString()),
      fmt(tax.toString()),
      "",
      `${list.length} ${currency === "Usdc" ? "USDC" : "NEAR"} invoice(s)`,
      "",
      "",
      "",
      "",
      "",
    ];
    return cells.map(csvCell).join(",");
  };

  const nearList = invoices.filter((i) => !isUsdcInvoice(i));
  const usdcList = invoices.filter(isUsdcInvoice);
  const totals = [
    totalRow("TOTAL (NEAR)", "Near", nearList),
    ...(usdcList.length > 0
      ? [totalRow("TOTAL (USDC)", "Usdc", usdcList)]
      : []),
  ];

  const csv = [header.join(","), ...rows, ...totals].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `twinnear-invoices-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
