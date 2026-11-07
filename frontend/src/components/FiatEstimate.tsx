import { useEffect, useState } from "react";
import { formatUsd, getNearUsdPrice } from "../lib/fiat";
import { formatNear, formatUsdc } from "../lib/near";
import type { Currency } from "../lib/types";

/**
 * Small fiat estimate ("≈ $12.34 (est.)") next to an invoice amount.
 * USDC is ≈ $1.00 by definition ("approx."); NEAR needs the CoinGecko
 * price. A failed price fetch hides the estimate silently — no error,
 * no placeholder. Always followed by the "Estimate only" note where
 * the spec asks for it (the caller adds it next to totals, not here).
 */
export default function FiatEstimate({
  amountSmallestUnit,
  currency,
  prefix = "≈ ",
  suffix = " (est.)",
}: {
  /** Amount in the currency's smallest unit (yoctoNEAR / micro-USDC). */
  amountSmallestUnit: string;
  currency: Currency;
  prefix?: string;
  suffix?: string;
}) {
  const [nearPrice, setNearPrice] = useState<number | null>(null);

  useEffect(() => {
    if (currency === "Usdc") return;
    let alive = true;
    getNearUsdPrice().then((p) => {
      if (alive) setNearPrice(p);
    });
    return () => {
      alive = false;
    };
  }, [currency]);

  if (currency === "Usdc") {
    let usdc: number;
    try {
      usdc = Number(formatUsdc(amountSmallestUnit));
    } catch {
      return null;
    }
    if (!Number.isFinite(usdc)) return null;
    return (
      <span className="fiat-est">
        {prefix}
        {formatUsd(usdc)} (approx.)
      </span>
    );
  }

  if (nearPrice === null) return null;
  let near: number;
  try {
    near = Number(formatNear(amountSmallestUnit));
  } catch {
    return null;
  }
  if (!Number.isFinite(near)) return null;
  return (
    <span className="fiat-est">
      {prefix}
      {formatUsd(near * nearPrice)}
      {suffix}
    </span>
  );
}
