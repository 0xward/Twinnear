import type { Currency } from "../lib/types";

/** Small currency pill — NEAR (ink green) or USDC (ledger brown). */
export default function CurrencyBadge({ currency }: { currency: Currency }) {
  return (
    <span
      className={
        currency === "Usdc" ? "stamp stamp-usdc" : "stamp stamp-near"
      }
      title={
        currency === "Usdc"
          ? "Denominated in USDC (micro-USDC on-chain)"
          : "Denominated in NEAR (yoctoNEAR on-chain)"
      }
    >
      {currency === "Usdc" ? "USDC" : "NEAR"}
    </span>
  );
}
