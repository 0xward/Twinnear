/**
 * Invoice PDF — premium paper layout, generated in the browser with
 * jspdf (no server, no data leaves the page).
 *
 * Layout: brand wordmark + header + rule, reference, created/due dates,
 * seller/client, line-items table (or the single description when the
 * invoice has no items), subtotal / tax / total, status stamp, a fiat
 * estimate note, and a footer. Amounts are shown in the invoice's own
 * currency; fiat is labelled an estimate, never a settlement rate.
 *
 * The brand mark is the user's TWINNEAR wordmark (public/logo.svg, a
 * traced vector). jsPDF cannot draw SVG, so the wordmark is rasterized
 * to JPEG on a canvas at export time: once at full strength for the
 * header, once at 7% opacity for the large faint watermark in the
 * middle of every page, behind the content. JPEG on a white canvas
 * keeps the file small (a PNG with alpha ballooned a one-page PDF to
 * 4.2 MB; the JPEG version is ~70 KB) and is invisible on the white
 * page, since the watermark is painted before any content. If the logo
 * cannot be loaded the PDF still builds, with a plain text header.
 */
import { jsPDF } from "jspdf";
import type { Invoice } from "./types";
import { formatNear, formatUsdc } from "./near";
import { formatDate } from "./near";
import { invoiceRef } from "./invoiceRef";
import { statusLabel } from "./invoiceStatus";

const INK = "#1c1a17";
const SOFT = "#5c564c";
const FAINT = "#6b6355";
const ACCENT = "#1f4d3a";
const LINE = "#c9c0ab";

// Wordmark aspect from public/logo.svg (viewBox 826 x 318).
const LOGO_RATIO = 826 / 318;

function money(inv: Invoice, smallestUnit: string): string {
  return inv.currency === "Usdc"
    ? `${formatUsdc(smallestUnit)} USDC`
    : `${formatNear(smallestUnit)} NEAR`;
}

export interface LogoImages {
  header: string; // JPEG data URL, full strength, on white
  watermark: string; // JPEG data URL, 7% opacity baked in, on white
}

function rasterizeSvg(
  svgText: string,
  widthPx: number,
  opacity: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(
      new Blob([svgText], { type: "image/svg+xml" }),
    );
    img.onload = () => {
      const scale = widthPx / img.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = widthPx;
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("no 2d context"));
        return;
      }
      // White canvas first: the JPEG has no alpha, and the page is
      // white, so the image blends invisibly into the paper.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("logo image failed to load"));
    };
    img.src = url;
  });
}

let logoCache: Promise<LogoImages | null> | null = null;

/** Fetch /logo.svg once and rasterize both PDF variants. Never throws. */
function loadLogoImages(): Promise<LogoImages | null> {
  if (!logoCache) {
    logoCache = (async () => {
      try {
        const res = await fetch("/logo.svg");
        if (!res.ok) return null;
        const svg = await res.text();
        const [header, watermark] = await Promise.all([
          rasterizeSvg(svg, 800, 1),
          rasterizeSvg(svg, 900, 0.07),
        ]);
        return { header, watermark };
      } catch {
        return null;
      }
    })();
  }
  return logoCache;
}

/**
 * Faint oversized wordmark in the middle of the current page, behind
 * the content: the authenticity watermark. The 7% opacity is baked
 * into the PNG, so no graphics-state tricks are needed; call it right
 * after creating a page, before any content is drawn on it.
 */
function paintWatermark(doc: jsPDF, images: LogoImages | null): void {
  if (!images) return;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const w = 380;
  const h = w / LOGO_RATIO;
  doc.addImage(images.watermark, "JPEG", (W - w) / 2, (H - h) / 2 - 20, w, h);
}

/** Pure builder: returns the document so tests can inspect it. */
export function buildInvoicePdf(
  inv: Invoice,
  images: LogoImages | null,
): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 56; // margin
  const right = W - M;
  let y = 64;

  // Watermark first, so all content sits on top of it.
  paintWatermark(doc, images);

  // --- Header: wordmark + rule ---
  const logoW = 150;
  const logoH = logoW / LOGO_RATIO;
  if (images) {
    doc.addImage(images.header, "JPEG", M, 40, logoW, logoH);
  } else {
    doc.setFont("times", "bold");
    doc.setFontSize(26);
    doc.setTextColor(INK);
    doc.text("Twinnear", M, y);
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(FAINT);
  doc.text("FREELANCER INVOICING ON NEAR", M, 40 + logoH + 16);
  doc.setFont("times", "bold");
  doc.setFontSize(20);
  doc.setTextColor(ACCENT);
  doc.text("INVOICE", right, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(SOFT);
  doc.text(invoiceRef(inv), right, y + 16, { align: "right" });
  y = 40 + logoH + 34;
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
            description: inv.description || "-",
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
      paintWatermark(doc, images);
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
  // Separator above the grand total. At this point y is the baseline the
  // bold "Total due" row will use; 13pt bold glyphs reach ~9pt above
  // their baseline, so a rule at y-6 struck straight through the text
  // (strikethrough). Draw the rule between the rows with clear space on
  // both sides instead.
  doc.setDrawColor(INK);
  doc.setLineWidth(1.2);
  doc.line(labelX - 10, y - 8, right, y - 8);
  y += 10; // breathing room between the rule and the total row
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
    "Fiat amounts shown in the app are rough estimates, not the rate you will be paid at.",
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
    "Twinnear · Freelancer invoicing on NEAR. Testnet invoice.",
    M,
    footerY,
  );
  // NOTE: do NOT use formatInvoiceAmount() here — it appends the "Ⓝ"
  // glyph, which jsPDF's built-in Helvetica (WinAnsi) cannot encode:
  // it renders as mojibake ("$Ã") and jsPDF mis-measures its width,
  // so the right-aligned text overshot the margin and clipped.
  // money() spells the currency out ("0.05 NEAR"), pure ASCII.
  doc.text(`Amount due: ${money(inv, inv.amount)}`, right, footerY, {
    align: "right",
  });

  return doc;
}

export async function downloadInvoicePdf(inv: Invoice): Promise<void> {
  const images = await loadLogoImages();
  const doc = buildInvoicePdf(inv, images);
  doc.save(`${invoiceRef(inv)}.pdf`);
}
