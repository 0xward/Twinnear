/**
 * Invoice PDF — premium paper layout, generated in the browser with
 * jspdf (no server, no data leaves the page).
 *
 * Layout: brand header + rule, reference, created/due dates,
 * seller/client, line-items table (or the single description when the
 * invoice has no items), subtotal / tax / total, status stamp, a fiat
 * estimate note, and a footer. Amounts are shown in the invoice's own
 * currency; fiat is labelled an estimate, never a settlement rate.
 */
import { jsPDF } from "jspdf";
import type { Invoice } from "./types";
import { formatInvoiceAmount, formatNear, formatUsdc } from "./near";
import { formatDate } from "./near";
import { invoiceRef } from "./invoiceRef";
import { statusLabel } from "./invoiceStatus";

const INK = "#1c1a17";
const SOFT = "#5c564c";
const FAINT = "#6b6355";
const ACCENT = "#1f4d3a";
const LINE = "#c9c0ab";

function money(inv: Invoice, smallestUnit: string): string {
  return inv.currency === "Usdc"
    ? `${formatUsdc(smallestUnit)} USDC`
    : `${formatNear(smallestUnit)} NEAR`;
}

export function downloadInvoicePdf(inv: Invoice): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 56; // margin
  const right = W - M;
  let y = 64;

  // --- Header: brand + rule ---
  doc.setFont("times", "bold");
  doc.setFontSize(26);
  doc.setTextColor(INK);
  doc.text("Twinnear", M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(FAINT);
  doc.text("FREELANCER INVOICING ON NEAR", M, y + 16);
  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.setTextColor(ACCENT);
  doc.text("INVOICE", right, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(SOFT);
  doc.text(invoiceRef(inv), right, y + 16, { align: "right" });
  y += 30;
  doc.setDrawColor(LINE);
  doc.setLineWidth(1);
  doc.line(M, y, right, y);
  y += 26;

  // --- Parties ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(FAINT);
  doc.text("FROM (SELLER)", M, y);
  doc.text("TO (CLIENT)", W / 2 + 12, y);
  y += 16;
  doc.setFont("times", "normal");
  doc.setFontSize(13);
  doc.setTextColor(INK);
  doc.text(inv.seller, M, y);
  doc.text(inv.client, W / 2 + 12, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(SOFT);
  doc.text(`Created: ${formatDate(inv.created_at)}`, M, y);
  doc.text(
    inv.due_date
      ? `Due: ${formatDate(inv.due_date)}`
      : "Due: no deadline set",
    W / 2 + 12,
    y,
  );
  y += 14;
  doc.text(`Status: ${statusLabel(inv)}`, M, y);
  if (inv.paid_at) {
    doc.text(`Paid: ${formatDate(inv.paid_at)}`, W / 2 + 12, y);
  }
  y += 30;

  // --- Line items ---
  const colDesc = M;
  const colQty = right - 190;
  const colUnit = right - 120;
  const colAmt = right;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(FAINT);
  doc.text("DESCRIPTION", colDesc, y);
  doc.text("QTY", colQty, y, { align: "right" });
  doc.text("UNIT PRICE", colUnit, y, { align: "right" });
  doc.text("AMOUNT", colAmt, y, { align: "right" });
  y += 8;
  doc.setDrawColor(LINE);
  doc.line(M, y, right, y);
  y += 18;

  doc.setFont("times", "normal");
  doc.setFontSize(12);
  doc.setTextColor(INK);
  const items =
    inv.items.length > 0
      ? inv.items
      : [
          {
            description: inv.description || "—",
            quantity: 1,
            unit_price: inv.amount,
          },
        ];
  for (const item of items) {
    const descLines = doc.splitTextToSize(
      item.description,
      colQty - colDesc - 12,
    ) as string[];
    const rowH = Math.max(16, descLines.length * 15);
    doc.text(descLines, colDesc, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(String(item.quantity), colQty, y, { align: "right" });
    doc.text(money(inv, item.unit_price), colUnit, y, { align: "right" });
    const lineTotal = (
      BigInt(item.quantity) * BigInt(item.unit_price)
    ).toString();
    doc.text(money(inv, lineTotal), colAmt, y, { align: "right" });
    doc.setFont("times", "normal");
    doc.setFontSize(12);
    y += rowH;
    if (y > 720) {
      doc.addPage();
      y = 64;
    }
  }
  doc.setDrawColor(LINE);
  doc.line(M, y, right, y);
  y += 20;

  // --- Totals ---
  const labelX = right - 190;
  const valueX = right;
  const totalRow = (
    label: string,
    value: string,
    bold: boolean,
  ): void => {
    doc.setFont(bold ? "helvetica" : "helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 13 : 11);
    doc.setTextColor(bold ? INK : SOFT);
    doc.text(label, labelX, y, { align: "right" });
    doc.text(value, valueX, y, { align: "right" });
    y += bold ? 22 : 18;
  };
  totalRow("Subtotal", money(inv, inv.subtotal), false);
  if (inv.tax_rate_bps > 0) {
    totalRow(
      `Tax (${(inv.tax_rate_bps / 100).toFixed(2).replace(/\.?0+$/, "")}%)`,
      money(inv, inv.tax_amount),
      false,
    );
  }
  doc.setDrawColor(INK);
  doc.setLineWidth(1.2);
  doc.line(labelX - 10, y - 6, right, y - 6);
  totalRow("Total due", money(inv, inv.amount), true);
  y += 8;

  // --- Notes ---
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(SOFT);
  const notes: string[] = [];
  if (inv.currency === "Usdc") {
    notes.push(
      "USDC invoice: settles via 1Click / NEAR Intents straight to the seller (no escrow). " +
        "The seller confirms receipt on-chain with confirm_external_payment.",
    );
  } else {
    notes.push(
      "NEAR invoice: the client pays the exact amount into escrow; the seller releases it or refunds it. " +
        "Pay at the link on the invoice page.",
    );
  }
  notes.push(
    "Fiat amounts shown in the app are estimates only — not the settlement rate.",
  );
  if (inv.external_ref) {
    notes.push(`External settlement reference: ${inv.external_ref}`);
  }
  if (inv.dispute_reason) {
    notes.push(`Dispute: ${inv.dispute_reason}`);
  }
  for (const note of notes) {
    const lines = doc.splitTextToSize(note, right - M) as string[];
    doc.text(lines, M, y);
    y += lines.length * 14 + 6;
  }

  // --- Footer ---
  const footerY = doc.internal.pageSize.getHeight() - 40;
  doc.setDrawColor(LINE);
  doc.setLineWidth(0.5);
  doc.line(M, footerY - 12, right, footerY - 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(FAINT);
  doc.text(
    "Twinnear — freelancer invoicing on NEAR. Testnet invoice; no AI.",
    M,
    footerY,
  );
  doc.text(`Amount due: ${formatInvoiceAmount(inv)}`, right, footerY, {
    align: "right",
  });

  doc.save(`${invoiceRef(inv)}.pdf`);
}
