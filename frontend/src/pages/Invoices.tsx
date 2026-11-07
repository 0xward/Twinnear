import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatDate, friendlyError, listAllInvoices } from "../lib/near";
import { exportInvoicesCsv } from "../lib/csv";
import { invoiceRef } from "../lib/invoiceRef";
import { stampClass, statusLabel } from "../lib/invoiceStatus";
import { downloadInvoicePdf } from "../lib/invoicePdf";
import CurrencyBadge from "../components/CurrencyBadge";
import { InvoiceAmount } from "../components/CurrencyIcon";
import FiatEstimate from "../components/FiatEstimate";
import Reveal from "../components/Reveal";
import type { Invoice, InvoiceStatus } from "../lib/types";

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"All" | InvoiceStatus>("All");
  const [searchParams, setSearchParams] = useSearchParams();
  const clientFilter = searchParams.get("client") ?? "";
  const [query, setQuery] = useState("");
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
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const shown = invoices.filter((i) => {
    if (filter !== "All" && i.status !== filter) return false;
    if (clientFilter && i.client !== clientFilter) return false;
    if (
      q &&
      !i.client.toLowerCase().includes(q) &&
      !i.description.toLowerCase().includes(q) &&
      !invoiceRef(i).toLowerCase().includes(q)
    )
      return false;
    return true;
  });

  return (
    <Reveal>
    <div className="card">
      <div className="page-head">
        <h2>Invoices</h2>
        <p className="sub">
          Every invoice on the contract, oldest first. Share a pay link with
          your client. They pay, funds sit in escrow, you release or refund.
          {total > 0 && ` Showing ${shown.length} of ${total}.`}
        </p>
      </div>

      {clientFilter && (
        <p className="muted" style={{ marginTop: -8 }}>
          Showing invoices for <strong>{clientFilter}</strong>{" "}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ minHeight: 0, padding: "2px 10px", marginLeft: 6 }}
            onClick={() => setSearchParams({})}
          >
            Clear
          </button>
        </p>
      )}

      <div className="chip-row">
        {(["All", "Pending", "Paid", "Refunded", "Cancelled"] as const).map((s) => (
          <button
            key={s}
            className={filter === s ? "btn" : "btn btn-ghost"}
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
        <input
          className="search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search client, description, or ref…"
          aria-label="Search invoices"
          autoComplete="off"
        />
        <button
          className="btn btn-ghost"
          onClick={() => exportInvoicesCsv(shown)}
          disabled={shown.length === 0}
        >
          Export CSV
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {loading ? (
        <p className="muted">Loading the ledger…</p>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            §
          </div>
          <p className="muted">
            No invoices match.{" "}
            <Link to="/invoices/new">Create the first one</Link>.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="ledger">
            <caption className="visually-hidden">
              Invoices, oldest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Client</th>
                <th scope="col">Description</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="visually-hidden">Open invoice</span>
                </th>
                <th scope="col">
                  <span className="visually-hidden">Download PDF</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((inv) => (
                <tr key={inv.id}>
                  <td>
                    <span className="ref">{invoiceRef(inv)}</span>
                  </td>
                  <td>{inv.client}</td>
                  <td>{inv.description}</td>
                  <td className="num">
                    <CurrencyBadge currency={inv.currency} />{" "}
                    <InvoiceAmount invoice={inv} />
                    <br />
                    <FiatEstimate
                      amountSmallestUnit={inv.amount}
                      currency={inv.currency}
                    />
                  </td>
                  <td>
                    <span className={stampClass(inv)}>
                      {statusLabel(inv)}
                      {inv.disputed ? " · disputed" : ""}
                    </span>
                  </td>
                  <td className="muted">{formatDate(inv.created_at)}</td>
                  <td>
                    <Link to={`/pay/${inv.id}`}>Open</Link>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => downloadInvoicePdf(inv)}
                    >
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </Reveal>
  );
}
