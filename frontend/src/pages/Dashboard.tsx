import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  formatDate,
  formatNear,
  formatUsdc,
  isUsdcInvoice,
  listAllInvoices,
} from "../lib/near";
import { exportInvoicesCsv } from "../lib/csv";
import { invoiceRef } from "../lib/invoiceRef";
import { stampClass, statusLabel } from "../lib/invoiceStatus";
import CurrencyBadge from "../components/CurrencyBadge";
import CurrencyIcon, { InvoiceAmount } from "../components/CurrencyIcon";
import FiatEstimate from "../components/FiatEstimate";
import TrustStrip from "../components/TrustStrip";
import type { Invoice } from "../lib/types";

interface ClientTotal {
  client: string;
  paidYocto: bigint;
  pendingYocto: bigint;
  paidUsdcMicro: bigint;
  pendingUsdcMicro: bigint;
  count: number;
  lastCreatedAt: number;
}

export default function Dashboard() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { invoices: all, total: count } = await listAllInvoices();
      setInvoices(all);
      setTotal(count);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load invoices.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const paid = invoices.filter((i) => i.status === "Paid");
  const pending = invoices.filter((i) => i.status === "Pending");
  const refunded = invoices.filter((i) => i.status === "Refunded");
  const cancelled = invoices.filter((i) => i.status === "Cancelled");
  // NEAR and USDC totals are kept separate — micro-USDC must never be
  // added to yoctoNEAR. The stat cards below are NEAR totals; the USDC
  // card (when any USDC invoice exists) shows the USDC side.
  const usdcInvoices = invoices.filter(isUsdcInvoice);
  const paidNear = paid.filter((i) => !isUsdcInvoice(i));
  const pendingNear = pending.filter((i) => !isUsdcInvoice(i));
  // "Received" counts escrow releases only. External (1Click)
  // settlements are the seller's own attestation — unverified — so
  // they get their own total instead of inflating Received (M-02).
  const receivedYocto = paidNear
    .filter((i) => i.released && i.external_ref === null)
    .reduce((sum, i) => sum + BigInt(i.amount), 0n);
  const externalYocto = paidNear
    .filter((i) => i.released && i.external_ref !== null)
    .reduce((sum, i) => sum + BigInt(i.amount), 0n);
  const escrowYocto = paidNear
    .filter((i) => !i.released)
    .reduce((sum, i) => sum + BigInt(i.amount), 0n);
  const outstandingYocto = pendingNear.reduce(
    (sum, i) => sum + BigInt(i.amount),
    0n,
  );
  const usdcOutstandingMicro = pending
    .filter(isUsdcInvoice)
    .reduce((sum, i) => sum + BigInt(i.amount), 0n);
  const usdcReceivedMicro = paid
    .filter((i) => isUsdcInvoice(i) && i.released)
    .reduce((sum, i) => sum + BigInt(i.amount), 0n);

  // Client directory: every client ever invoiced, not just paid ones.
  // NEAR and USDC are tracked in separate columns — never added.
  const perClient = new Map<string, ClientTotal>();
  for (const inv of invoices) {
    const cur = perClient.get(inv.client) ?? {
      client: inv.client,
      paidYocto: 0n,
      pendingYocto: 0n,
      paidUsdcMicro: 0n,
      pendingUsdcMicro: 0n,
      count: 0,
      lastCreatedAt: 0,
    };
    const usdc = isUsdcInvoice(inv);
    if (inv.status === "Paid") {
      if (usdc) cur.paidUsdcMicro += BigInt(inv.amount);
      else cur.paidYocto += BigInt(inv.amount);
    }
    if (inv.status === "Pending") {
      if (usdc) cur.pendingUsdcMicro += BigInt(inv.amount);
      else cur.pendingYocto += BigInt(inv.amount);
    }
    cur.count += 1;
    cur.lastCreatedAt = Math.max(cur.lastCreatedAt, inv.created_at);
    perClient.set(inv.client, cur);
  }
  const clients = [...perClient.values()].sort((a, b) =>
    a.paidYocto + a.pendingYocto === b.paidYocto + b.pendingYocto
      ? b.lastCreatedAt - a.lastCreatedAt
      : a.paidYocto + a.pendingYocto < b.paidYocto + b.pendingYocto
        ? 1
        : -1,
  );

  /** "1.5 [NEAR]" plus " · 12.00 [USDC]" when the client also has USDC. */
  function clientCell(nearYocto: bigint, usdcMicro: bigint) {
    const near =
      nearYocto > 0n ? (
        <span key="near">
          {formatNear(nearYocto.toString())}{" "}
          <CurrencyIcon currency="Near" />
        </span>
      ) : null;
    const usdc =
      usdcMicro > 0n ? (
        <span key="usdc">
          {formatUsdc(usdcMicro.toString())}{" "}
          <CurrencyIcon currency="Usdc" />
        </span>
      ) : null;
    if (!near && !usdc) return "-";
    return (
      <>
        {near}
        {near && usdc ? " · " : null}
        {usdc}
      </>
    );
  }

  const recent = [...invoices]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  return (
    <div>
      <div className="page-head">
        <h1>The ledger</h1>
        <p className="muted">
          What you have received, what is held in escrow, and what is still
          owed to you, at a glance.
        </p>
        <p className="muted page-head-help">
          New here? <Link to="/about">Read what Twinnear is</Link>.
        </p>
      </div>

      <TrustStrip />

      <div className="stat-grid">
        <div className="stat">
          <div className="label">Received (released)</div>
          <div className="value amount">
            {formatNear(receivedYocto.toString())}{" "}
            <CurrencyIcon currency="Near" size="sm" />
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            escrow released to you ·{" "}
            <FiatEstimate
              amountSmallestUnit={receivedYocto.toString()}
              currency="Near"
            />
          </div>
        </div>
        <div className="stat">
          <div className="label">External (unverified)</div>
          <div className="value amount">
            {formatNear(externalYocto.toString())}{" "}
            <CurrencyIcon currency="Near" size="sm" />
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            1Click payments confirmed by the seller, not checked on-chain
          </div>
        </div>
        <div className="stat">
          <div className="label">In escrow</div>
          <div className="value amount">
            {formatNear(escrowYocto.toString())}{" "}
            <CurrencyIcon currency="Near" size="sm" />
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            <FiatEstimate
              amountSmallestUnit={escrowYocto.toString()}
              currency="Near"
            />
          </div>
        </div>
        <div className="stat">
          <div className="label">Outstanding</div>
          <div className="value amount">
            {formatNear(outstandingYocto.toString())}{" "}
            <CurrencyIcon currency="Near" size="sm" />
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            {pendingNear.length} unpaid NEAR invoice
            {pendingNear.length === 1 ? "" : "s"} ·{" "}
            <FiatEstimate
              amountSmallestUnit={outstandingYocto.toString()}
              currency="Near"
            />
          </div>
        </div>
        {usdcInvoices.length > 0 && (
          <div className="stat">
            <div className="label">USDC (via 1Click)</div>
            <div className="value amount">
              {formatUsdc(usdcOutstandingMicro.toString())}{" "}
              <CurrencyIcon currency="Usdc" size="sm" />
            </div>
            <div className="label" style={{ marginTop: 2 }}>
              outstanding · {formatUsdc(usdcReceivedMicro.toString())}{" "}
              <CurrencyIcon currency="Usdc" /> received ·{" "}
              <FiatEstimate
                amountSmallestUnit={usdcOutstandingMicro.toString()}
                currency="Usdc"
              />
            </div>
          </div>
        )}
        <div className="stat">
          <div className="label">Refunded</div>
          <div className="value amount">{refunded.length}</div>
        </div>
        <div className="stat">
          <div className="label">Cancelled</div>
          <div className="value amount">{cancelled.length}</div>
        </div>
      </div>
      <p className="muted" style={{ marginTop: -8, marginBottom: 18 }}>
        Fiat amounts are rough estimates, not the rate you will be paid at.
      </p>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="card">
        <h2>Clients</h2>
        <p className="sub">
          Everyone you have invoiced, with what they paid and what is still
          open. Select a client to see their invoices.
          {total > 0 && ` Showing all ${total} invoice${total === 1 ? "" : "s"}.`}
        </p>
        {loading ? (
          <p className="muted">Loading the ledger…</p>
        ) : clients.length === 0 ? (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">
              §
            </div>
            <p className="muted">
              No invoices yet. The ledger is blank.{" "}
              <Link to="/invoices/new">Create the first one</Link>.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Clients, with invoice counts and paid and outstanding totals
              </caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Invoices</th>
                  <th scope="col">Paid</th>
                  <th scope="col">Outstanding</th>
                  <th scope="col">Last invoice</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.client}>
                    <td>
                      <Link
                        to={`/invoices?client=${encodeURIComponent(c.client)}`}
                      >
                        {c.client}
                      </Link>
                    </td>
                    <td className="num">{c.count}</td>
                    <td className="num">
                      {clientCell(c.paidYocto, c.paidUsdcMicro)}
                    </td>
                    <td className="num">
                      {clientCell(c.pendingYocto, c.pendingUsdcMicro)}
                    </td>
                    <td className="muted">{formatDate(c.lastCreatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent invoices</h2>
        <p className="sub">The five newest entries in the ledger.</p>
        {loading ? (
          <p className="muted">Loading the ledger…</p>
        ) : recent.length === 0 ? (
          <p className="muted">
            Nothing here yet.{" "}
            <Link to="/invoices/new">Create the first one</Link>.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Recent invoices, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ref</th>
                  <th scope="col">Client</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Open invoice</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <span className="ref">{invoiceRef(inv)}</span>
                    </td>
                    <td>{inv.client}</td>
                    <td className="num">
                      <CurrencyBadge currency={inv.currency} />{" "}
                      <InvoiceAmount invoice={inv} />
                    </td>
                    <td>
                      <span className={stampClass(inv)}>
                        {statusLabel(inv)}
                      </span>
                    </td>
                    <td>
                      <Link to={`/pay/${inv.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <hr className="rule" />
        <div className="row">
          <button
            className="btn btn-ghost"
            onClick={() => exportInvoicesCsv(invoices)}
            disabled={invoices.length === 0}
          >
            Export CSV
          </button>
          <button className="btn btn-ghost" onClick={load}>
            Refresh
          </button>
          <span className="spacer" />
          <Link className="btn" to="/invoices/new">
            New invoice
          </Link>
        </div>
      </div>
    </div>
  );
}
