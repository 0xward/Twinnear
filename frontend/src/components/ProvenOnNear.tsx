import { Link } from "react-router-dom";
import CardWatermark from "./CardWatermark";

/**
 * "Proven on NEAR" — three real on-chain receipts from the testnet
 * ledger, each linking to the transaction on the explorer. All three
 * hashes were verified against the NEAR RPC (FastNear, `tx` method,
 * 2026-11-07): each returns SuccessValue on twinnear.testnet.
 * Invoice #2 has no saved creation hash, so its card says so plainly
 * instead of linking to a transaction that does not exist.
 */
const EXPLORER_TX = "https://explorer.testnet.near.org/transactions";

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a href={`${EXPLORER_TX}/${hash}`} target="_blank" rel="noreferrer" title={hash}>
      {label} {shortHash(hash)}
    </a>
  );
}

export default function ProvenOnNear() {
  return (
    <div className="card">
      <h2>Proven on NEAR</h2>
      <p className="sub">
        Every claim below links to a real transaction on NEAR testnet.
        Check it yourself.
      </p>
      <div className="proof-grid">
        <div className="proof-card stagger-item tint-green">
          <CardWatermark tint="tint-green" icon="handshake" />
          <h3>Invoice #1, paid and released</h3>
          <p>
            0.05 NEAR, paid by the client into escrow and released to the
            seller after the work was done.
          </p>
          <p className="proof-links">
            <TxLink
              hash="GWzwgrctqSBdYhG79LSo5BM1RwU8RxQBBVyyT7bpQTLA"
              label="Payment"
            />
            <TxLink
              hash="ARUyJbgZTvdgTtR58p2F8PPTDKB977TjpLMyweziwRNJ"
              label="Release"
            />
            <Link to="/invoice/1">See invoice #1</Link>
          </p>
        </div>
        <div className="proof-card stagger-item tint-teal">
          <CardWatermark tint="tint-teal" icon="gas" />
          <h3>Invoice #4, created gasless</h3>
          <p>
            The seller paid no gas. A signed message, verified by the
            server, submitted by the relayer.
          </p>
          <p className="proof-links">
            <TxLink
              hash="2iMVmF156UnK3WR1nHJxnwgCYSisy8585NNGQtBKnXz4"
              label="Creation"
            />
            <Link to="/invoice/4">See invoice #4</Link>
          </p>
        </div>
        <div className="proof-card stagger-item tint-lavender">
          <h3>Invoice #2, a retainer</h3>
          <p>
            1.01 NEAR recurring invoice, subtotal 1.00 NEAR plus 1% tax,
            created on-chain by the retainer.
          </p>
          <p className="muted">
            No transaction hash was saved for this one.
          </p>
          <p className="proof-links">
            <Link to="/invoice/2">See invoice #2</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
