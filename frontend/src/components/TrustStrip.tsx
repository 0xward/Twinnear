import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  formatNear,
  getInvoiceCount,
  getTotalEscrowed,
  getVersion,
} from "../lib/near";
import { CONTRACT_ID, EXPLORER_URL } from "../lib/config";
import CurrencyIcon from "./CurrencyIcon";

/**
 * Trust strip: live on-chain facts, read with the view calls that
 * already exist in lib/near.ts. Numbers are shown only when the view
 * call succeeds; when it fails the strip stays up without numbers,
 * never with invented ones.
 */
export default function TrustStrip() {
  const [count, setCount] = useState<number | null>(null);
  const [escrowed, setEscrowed] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    getInvoiceCount()
      .then((n) => {
        if (alive) setCount(n);
      })
      .catch(() => {});
    getTotalEscrowed()
      .then((v) => {
        if (alive) setEscrowed(v);
      })
      .catch(() => {});
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="trust-strip" aria-label="Live status">
      {/* Row 1 — live facts only. Row 2 (below the hairline) holds
       * the claim and the links, so facts, claims, and links no
       * longer share one undifferentiated voice (P1). */}
      <div className="trust-facts">
        <span className="stamp stamp-paid">Testnet</span>
        <span>
          Contract{" "}
          <a
            href={`${EXPLORER_URL}/accounts/${CONTRACT_ID}`}
            target="_blank"
            rel="noreferrer"
          >
            {CONTRACT_ID}
          </a>
          {version !== null && ` · schema v${version}`}
        </span>
        {count !== null && (
          <span>
            {count} invoice{count === 1 ? "" : "s"} on chain
          </span>
        )}
        {escrowed !== null && (
          <span style={{ whiteSpace: "nowrap" }}>
            {formatNear(escrowed)} <CurrencyIcon currency="Near" /> in
            escrow now
          </span>
        )}
      </div>
      <div className="trust-claim">
        <span>No fees. No signup. No custody.</span>
        {/* Links grouped and pushed right: they travel as one unit
         * (they no longer dangle one per line when the strip wraps
         * on a phone). */}
        <span className="trust-links">
          <span>
            <Link to="/invoice/1">See invoice #1, paid and released</Link>
          </span>
          <span>
            <Link to="/about">What is Twinnear?</Link>
          </span>
        </span>
      </div>
    </div>
  );
}
