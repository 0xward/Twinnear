import type { Invoice } from "./types";
import { formatNearFull } from "./near";
import { invoiceRef } from "./invoiceRef";

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Build a bookkeeper-friendly CSV of invoices and trigger a download.
 * Columns are stable (header first, one TOTAL row last) so the file can
 * be imported into a spreadsheet or ledger without rework.
 */
export function exportInvoicesCsv(invoices: Invoice[]): void {
  const header = [
    "invoice_ref",
    "id",
    "seller",
    "client",
    "amount_near",
    "amount_yocto",
    "description",
    "status",
    "released",
    "created_at",
    "paid_at",
    "external_ref",
  ];
  const rows = invoices.map((inv) =>
    [
      invoiceRef(inv),
      String(inv.id),
      inv.seller,
      inv.client,
      // Full precision (L-06): 0.00001 NEAR must not export as 0.
      formatNearFull(inv.amount),
      inv.amount,
      inv.description,
      inv.status,
      inv.released ? "yes" : "no",
      new Date(Math.floor(inv.created_at / 1_000_000)).toISOString(),
      inv.paid_at
        ? new Date(Math.floor(inv.paid_at / 1_000_000)).toISOString()
        : "",
      inv.external_ref ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  const totalYocto = invoices.reduce(
    (sum, inv) => sum + BigInt(inv.amount),
    0n,
  );
  const totalRow = [
    "TOTAL",
    String(invoices.length),
    "",
    "",
    formatNearFull(totalYocto.toString()),
    totalYocto.toString(),
    `${invoices.length} invoice(s)`,
    "",
    "",
    "",
    "",
    "",
  ]
    .map(csvCell)
    .join(",");
  const csv = [header.join(","), ...rows, totalRow].join("\n");
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
