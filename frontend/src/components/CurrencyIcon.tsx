import nearSvg from "../assets/near.svg";
import usdcSvg from "../assets/usdc.svg";
import { formatNear, formatUsdc, isUsdcInvoice } from "../lib/near";
import type { Currency, Invoice } from "../lib/types";

/**
 * Official currency mark shown after an amount, e.g. "1.5 [NEAR]".
 *
 * Local SVG files (no hotlink): NEAR's angular "N" mark (Simple
 * Icons, CC0, traced from NEAR's official brand mark) and USDC's
 * blue "$" coin (cryptocurrency-icons, traced from Circle's official
 * USDC mark). Rendered at ~1em so it scales with the surrounding
 * text and sits on the baseline like the old Ⓝ glyph did.
 *
 * The PDF deliberately does NOT use this (invoicePdf.ts avoids the
 * Ⓝ glyph for font reasons and writes the currency as text).
 */
export default function CurrencyIcon({
  currency,
}: {
  currency: Currency | string;
}) {
  const isUsdc = currency === "Usdc";
  return (
    <img
      src={isUsdc ? usdcSvg : nearSvg}
      alt={isUsdc ? "USDC" : "NEAR"}
      title={isUsdc ? "USDC" : "NEAR"}
      className="currency-icon"
    />
  );
}

/** An invoice amount with its official currency mark. */
export function InvoiceAmount({ invoice }: { invoice: Invoice }) {
  const isUsdc = isUsdcInvoice(invoice);
  return (
    <>
      {isUsdc ? formatUsdc(invoice.amount) : formatNear(invoice.amount)}{" "}
      <CurrencyIcon currency={invoice.currency ?? "Near"} />
    </>
  );
}
