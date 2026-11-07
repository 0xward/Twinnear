import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  formatDate,
  formatInvoiceAmount,
  friendlyError,
  getSignedInAccount,
  listAllInvoices,
  onAccountChange,
} from "../lib/near";
import { invoiceRef } from "../lib/invoiceRef";
import { stampClass } from "../lib/invoiceStatus";
import CurrencyBadge from "../components/CurrencyBadge";
import FiatEstimate from "../components/FiatEstimate";
import type { Invoice } from "../lib/types";

/**
 * Client portal — the client's own view of their invoices.
 * Plain language, no jargon: no "yocto", no "escrow" anywhere on this
 * page. A client connects their wallet and sees ONLY the invoices
 * billed to them, with a Pay button to the invoice page.
 */
export function clientStatusLabel(inv: Invoice): string {
  if (inv.status === "Refunded") return "Refunded";
  if (inv.status === "Cancelled") return "Cancelled";
  if (inv.status === "Paid" && inv.external_ref !== null) {
    return "Paid via external payment";
  }
  if (inv.status === "Paid" && inv.released) return "Paid";
  if (inv.status === "Paid") return "Paid — held securely";
  return "Awaiting your payment";
}

export default function Portal() {
  const [account, setAccount] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const acct = await getSignedInAccount();
      setAccount(acct);
      if (acct) {
        const { invoices: all } = await listAllInvoices();
        setInvoices(
          all
            .filter((i) => i.client === acct)
            .sort((a, b) => b.created_at - a.created_at),
        );
      } else {
        setInvoices([]);
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Follow wallet account changes live (same as the header).
    let unsubscribe: (() => void) | null = null;
    onAccountChange((acct) => {
      setAccount(acct);
      load();
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(() => undefined);
    return () => {
      unsubscribe?.();
    };
  }, [load]);

  const awaiting = invoices.filter((i) => i.status === "Pending");
  const done = invoices.filter((i) => i.status !== "Pending");

  return (
    <div className="card">
      <h2>Client portal</h2>
      <p className="sub">
        Your invoices from Twinnear sellers — nothing else, no jargon.
        Connect your wallet to see what you owe and what you have paid.
      </p>

      {error && <div className="error" role="alert">{error}</div>}

      {!account ? (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            §
          </div>
          <p className="muted">
            Connect your wallet (button at the top) to see your invoices.
          </p>
        </div>
      ) : loading ? (
        <p className="muted">Loading your invoices…</p>
      ) : invoices.length === 0 ? (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            §
          </div>
          <p className="muted">
            No invoices for <strong>{account}</strong> yet. When a seller
            bills you, it will appear here.
          </p>
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginTop: -6 }}>
            Signed in as <strong>{account}</strong> · {awaiting.length}{" "}
            awaiting payment · {done.length} settled
          </p>

          {awaiting.length > 0 && (
            <>
              <h3 style={{ margin: "18px 0 8px" }}>Awaiting your payment</h3>
              <div className="table-scroll">
                <table className="ledger">
                  <caption className="visually-hidden">
                    Invoices awaiting your payment
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Ref</th>
                      <th scope="col">From</th>
                      <th scope="col">What for</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Due</th>
                      <th scope="col">
                        <span className="visually-hidden">Pay</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {awaiting.map((inv) => (
                      <tr key={inv.id}>
                        <td>
                          <span className="ref">{invoiceRef(inv)}</span>
                        </td>
                        <td>{inv.seller}</td>
                        <td>{inv.description || "—"}</td>
                        <td className="num">
                          <CurrencyBadge currency={inv.currency} />{" "}
                          {formatInvoiceAmount(inv)}
                          <br />
                          <FiatEstimate
                            amountSmallestUnit={inv.amount}
                            currency={inv.currency}
                          />
                        </td>
                        <td className="muted">
                          {inv.due_date
                            ? formatDate(inv.due_date)
                            : "No deadline"}
                        </td>
                        <td>
                          <Link className="btn btn-ghost btn-small" to={`/pay/${inv.id}`}>
                            Pay
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {done.length > 0 && (
            <>
              <h3 style={{ margin: "18px 0 8px" }}>Settled</h3>
              <div className="table-scroll">
                <table className="ledger">
                  <caption className="visually-hidden">
                    Settled invoices
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Ref</th>
                      <th scope="col">From</th>
                      <th scope="col">What for</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {done.map((inv) => (
                      <tr key={inv.id}>
                        <td>
                          <span className="ref">{invoiceRef(inv)}</span>
                        </td>
                        <td>{inv.seller}</td>
                        <td>{inv.description || "—"}</td>
                        <td className="num">{formatInvoiceAmount(inv)}</td>
                        <td>
                          <span className={stampClass(inv)}>
                            {clientStatusLabel(inv)}
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
            </>
          )}
          <p className="muted" style={{ marginTop: 14 }}>
            “Paid — held securely” means your payment is with the contract
            until the seller confirms the work is done. Fiat amounts are
            estimates only — not the settlement rate.
          </p>
        </>
      )}
    </div>
  );
}
