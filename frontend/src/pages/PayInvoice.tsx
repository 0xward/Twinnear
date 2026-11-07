import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  cancelInvoice,
  claimRefund,
  confirmExternalPayment,
  extractTxHash,
  formatDate,
  formatInvoiceAmount,
  formatNear,
  formatUsdc,
  friendlyError,
  getAccountBalance,
  getInvoice,
  getSignedInAccount,
  isUsdcInvoice,
  openDispute,
  payInvoice,
  refundInvoice,
  releaseInvoice,
  withdrawDispute,
} from "../lib/near";
import {
  MAINNET_ONLY_NOTE,
  SOURCE_ASSETS,
  USDC_NEAR_ASSET,
  getSwapStatus,
  pollSwapStatus,
  quoteIntentSettlement,
  refundAddressPlaceholder,
  validateRefundAddress,
} from "../lib/intents";
import type { IntentQuote, SwapStatus } from "../lib/intents";
import type { Invoice } from "../lib/types";
import { stampClass, statusLabel } from "../lib/invoiceStatus";
import CopyButton from "../components/CopyButton";
import CurrencyBadge from "../components/CurrencyBadge";
import CurrencyIcon, { InvoiceAmount } from "../components/CurrencyIcon";
import FiatEstimate from "../components/FiatEstimate";
import InvoiceTimeline from "../components/InvoiceTimeline";
import PayQr from "../components/PayQr";
import { buildReminderText, invoiceRef } from "../lib/invoiceRef";
import { downloadInvoicePdf } from "../lib/invoicePdf";
import { EXPLORER_URL } from "../lib/config";
import Reveal from "../components/Reveal";

export default function PayInvoice() {
  const { id } = useParams<{ id: string }>();
  const invoiceId = Number(id);
  const idValid = Number.isInteger(invoiceId) && invoiceId > 0;
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // 1Click cross-chain settlement (mainnet only — see MAINNET_ONLY_NOTE).
  const [sourceAsset, setSourceAsset] = useState(SOURCE_ASSETS[0].assetId);
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<IntentQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [polling, setPolling] = useState(false);

  // Seller confirmation of an external (1Click) settlement.
  const [extRef, setExtRef] = useState("");
  // Client dispute.
  const [disputeReason, setDisputeReason] = useState("");

  const load = useCallback(async () => {
    if (!idValid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAccount(await getSignedInAccount());
      setInvoice(await getInvoice(invoiceId));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [invoiceId, idValid]);

  useEffect(() => {
    load();
  }, [load]);

  // Prefill the seller-confirmation field from the live quote (M-02):
  // the deposit address is the proof, no manual copy-paste needed.
  useEffect(() => {
    if (quote?.depositAddress) setExtRef(quote.depositAddress);
  }, [quote?.depositAddress]);

  /**
   * M-06: after submit, do NOT reload immediately — the transaction is
   * not final yet and the old status would confuse everyone. Show the
   * tx hash + explorer link and a manual "Refresh status" button.
   */
  async function run(action: () => Promise<unknown>, label: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    setTxHash(null);
    try {
      const res = await action();
      const hash = extractTxHash(res);
      setTxHash(hash);
      setDone(
        `${label} submitted. Confirm it in your wallet, then press "Refresh status" below to see the result.`,
      );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * M-05: pre-flight balance check — paying attaches the FULL invoice
   * amount plus gas, so compare the client's LIVE available balance
   * first (same pattern as elsewhere in the app) instead of letting the
   * wallet fail with a generic error and burn gas.
   * NEAR escrow only — USDC invoices never reach this button
   * (they settle via 1Click, see below).
   */
  async function handlePay() {
    if (!invoice || !account || isUsdcInvoice(invoice)) return;
    try {
      const bal = await getAccountBalance(account);
      // Gas for a 100-Tgas function call at the minimum gas price is
      // ~0.01 NEAR; keep that as the reserve so a payment that would
      // strand the account is refused up front with a clear message.
      const GAS_RESERVE_YOCTO = 10n ** 22n; // 0.01 NEAR
      const need = BigInt(invoice.amount) + GAS_RESERVE_YOCTO;
      if (BigInt(bal.availableYocto) < need) {
        setError(
          `Not enough NEAR to pay: this invoice is ${formatNear(invoice.amount)} NEAR ` +
            `and the transaction needs about 0.01 NEAR for gas, but ${account} ` +
            `has only ${formatNear(bal.availableYocto)} NEAR available. ` +
            "Top up from the testnet faucet first, then try again.",
        );
        return;
      }
    } catch {
      // Balance unreadable (RPC hiccup) — do not block the payment;
      // the wallet will report a real shortfall if there is one.
    }
    await run(() => payInvoice(invoice.id, invoice.amount), "Payment");
  }

  async function requestQuote(dry: boolean) {
    if (!invoice) return;
    setQuoteError(null);
    setQuoteBusy(true);
    try {
      // Refund address format depends on the origin chain (EVM,
      // Solana, or Bitcoin) — validated per asset, not one regex.
      const selectedAsset = SOURCE_ASSETS.find(
        (a) => a.assetId === sourceAsset,
      );
      const refundError = selectedAsset
        ? validateRefundAddress(selectedAsset, refundTo)
        : "Pick a payment source first.";
      if (refundError) {
        throw new Error(refundError);
      }
      const q = await quoteIntentSettlement({
        sourceAsset,
        amountOutBaseUnits: invoice.amount,
        // USDC invoices settle in USDC on NEAR (micro-USDC, the
        // invoice amount as-is); NEAR invoices settle in wNEAR.
        destinationAsset: isUsdcInvoice(invoice)
          ? USDC_NEAR_ASSET
          : undefined,
        recipient: invoice.seller,
        refundTo: refundTo.trim(),
        dry,
      });
      setQuote(q);
      if (!dry && q.depositAddress) {
        setSwapStatus(await getSwapStatus(q.depositAddress));
      }
    } catch (e) {
      setQuoteError(friendlyError(e));
      setQuote(null);
    } finally {
      setQuoteBusy(false);
    }
  }

  async function pollStatus() {
    if (!quote?.depositAddress) return;
    setPolling(true);
    try {
      await pollSwapStatus(quote.depositAddress, setSwapStatus, {
        intervalMs: 15_000,
        maxAttempts: 40,
      });
    } catch (e) {
      setQuoteError(friendlyError(e));
    } finally {
      setPolling(false);
    }
  }

  if (!idValid) {
    return (
      <div className="card">
        <h2>Invalid invoice link</h2>
        <p className="sub">
          “{id}” is not an invoice number.{" "}
          <Link to="/invoices">Back to invoices</Link>
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card">
        <p className="muted">Loading invoice…</p>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="card">
        <h2>Invoice not found</h2>
        <p className="sub">
          No invoice #{id} on the contract.{" "}
          <Link to="/invoices">Back to invoices</Link>
        </p>
      </div>
    );
  }

  const isClient = account === invoice.client;
  const isSeller = account === invoice.seller;
  const shareUrl = `${window.location.origin}${window.location.pathname}#/pay/${invoice.id}`;
  const ref = invoiceRef(invoice);
  const reminderText = buildReminderText(
    ref,
    formatInvoiceAmount(invoice),
    invoice.description,
    shareUrl,
  );
  const isUsdc = isUsdcInvoice(invoice);
  // 1Click destination label: USDC invoices settle in USDC on NEAR,
  // NEAR invoices in wNEAR.
  const destinationLabel = isUsdc ? "USDC" : "wNEAR";
  const sourceLabel =
    SOURCE_ASSETS.find((a) => a.assetId === sourceAsset)?.label ?? sourceAsset;
  const nowNs = Date.now() * 1_000_000;
  const overdue =
    invoice.status === "Pending" &&
    invoice.due_date !== null &&
    nowNs >= invoice.due_date;
  const pastDue =
    invoice.status === "Paid" &&
    !invoice.released &&
    invoice.due_date !== null &&
    nowNs >= invoice.due_date;
  // One plain sentence on what the status means right now, so a
  // first-time visitor is never left guessing what happens next.
  const statusExplainer =
    invoice.status === "Pending"
      ? "Nothing is held yet. Once the client pays, the money moves into escrow, and this timeline fills in."
      : invoice.status === "Paid" && !invoice.released
        ? "The money is in escrow now. The seller releases it on delivery, or refunds it."
        : invoice.status === "Paid" && invoice.released
          ? "Done. The escrow was released to the seller."
          : invoice.status === "Refunded"
            ? "Done. The escrow went back to the client."
            : "Cancelled before payment. Nothing moved.";
  // L-04: 1Click is mainnet-only — a .testnet recipient is always
  // rejected by the API, so disable the section up front.
  const oneClickBlocked = invoice.seller.endsWith(".testnet");

  return (
    <Reveal>
    <div className="card">
      <div className="page-head">
        <h2>
          Invoice #{invoice.id}{" "}
          <span className={stampClass(invoice)}>
            {statusLabel(invoice)}
          </span>{" "}
          <CurrencyBadge currency={invoice.currency} />
          {overdue && (
            <span className="stamp stamp-refunded" style={{ marginLeft: 8 }}>
              Overdue
            </span>
          )}
          {invoice.disputed && (
            <span className="stamp stamp-pending" style={{ marginLeft: 8 }}>
              Disputed
            </span>
          )}
        </h2>
        <p className="sub">
          <span className="ref">{ref}</span>
          {invoice.description ? ` · ${invoice.description}` : ""}
        </p>
        {isClient && invoice.status === "Pending" && (
          <p className="sub" style={{ marginTop: 8 }}>
            This invoice is from {invoice.seller}. Pay the exact amount
            below. {isUsdc
              ? "your payment goes straight to the seller via 1Click."
              : "your payment is held safely by the contract until the seller releases it, or refunds you."}
          </p>
        )}
      </div>

      {invoice.status === "Pending" && (isClient || !account) && (
        <div className="notice-info" aria-label="For the client">
          <strong>For the client.</strong>{" "}
          {isUsdc ? (
            <>
              This is a USDC invoice. Your payment goes straight to the
              seller through 1Click, with no escrow. Pay one only if you
              trust the seller.{" "}
            </>
          ) : (
            <>
              Your money waits in the middle. When you pay, the exact
              amount is held by the contract in escrow, not by the
              seller, and it is released only when the seller releases
              it, or refunded to you. If the work was not delivered,
              open a dispute below: it blocks the release. If the due
              date has passed and the seller stays silent, you can
              claim the refund yourself.{" "}
            </>
          )}
          <Link to="/docs#paying-an-invoice">
            How paying works, step by step
          </Link>
          .
        </div>
      )}

      <dl className="kv">
        <dt>Amount due</dt>
        <dd className="amount" style={{ fontSize: 26 }}>
          <InvoiceAmount invoice={invoice} />{" "}
          <FiatEstimate
            amountSmallestUnit={invoice.amount}
            currency={invoice.currency}
          />
        </dd>
        <dt>Seller</dt>
        <dd>{invoice.seller}</dd>
        <dt>Client</dt>
        <dd>{invoice.client}</dd>
        <dt>Created</dt>
        <dd>{formatDate(invoice.created_at)}</dd>
        <dt>Due date</dt>
        <dd>
          {invoice.due_date
            ? formatDate(invoice.due_date)
            : "No deadline set"}
        </dd>
        {invoice.due_date === null && invoice.status === "Pending" && isClient && (
          <>
            <dt>Heads up</dt>
            <dd>
              This invoice has no payment deadline, so there is no
              claim-refund escape if the seller goes silent. Pay only if
              you trust this seller.
            </dd>
          </>
        )}
        {invoice.paid_at && (
          <>
            <dt>Paid</dt>
            <dd>{formatDate(invoice.paid_at)}</dd>
          </>
        )}
        {invoice.external_ref && (
          <>
            <dt>External ref</dt>
            <dd style={{ wordBreak: "break-all" }}>{invoice.external_ref}</dd>
          </>
        )}
        {invoice.dispute_reason && (
          <>
            <dt>Dispute</dt>
            <dd style={{ wordBreak: "break-all" }}>{invoice.dispute_reason}</dd>
          </>
        )}
      </dl>

      {invoice.items.length > 0 && (
        <>
          <h3 style={{ margin: "18px 0 8px" }}>What you&apos;re paying for</h3>
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Line items for this invoice
              </caption>
              <thead>
                <tr>
                  <th scope="col">Description</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Unit price</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">
                      {isUsdc
                        ? formatUsdc(item.unit_price)
                        : formatNear(item.unit_price)}{" "}
                      <CurrencyIcon currency={invoice.currency ?? "Near"} />
                    </td>
                    <td className="num">
                      {isUsdc
                        ? formatUsdc(
                            (
                              BigInt(item.quantity) * BigInt(item.unit_price)
                            ).toString(),
                          )
                        : formatNear(
                            (
                              BigInt(item.quantity) * BigInt(item.unit_price)
                            ).toString(),
                          )}{" "}
                      <CurrencyIcon currency={invoice.currency ?? "Near"} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Subtotal</td>
                  <td className="num">
                    <InvoiceAmount
                      invoice={{ ...invoice, amount: invoice.subtotal }}
                    />
                  </td>
                </tr>
                {invoice.tax_rate_bps > 0 && (
                  <tr>
                    <td colSpan={3}>
                      Tax ({(invoice.tax_rate_bps / 100).toString()}%)
                    </td>
                    <td className="num">
                      <InvoiceAmount
                        invoice={{ ...invoice, amount: invoice.tax_amount }}
                      />
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3}>
                    <strong>Total due</strong>
                  </td>
                  <td className="num">
                    <strong>
                      <InvoiceAmount invoice={invoice} />
                    </strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
      <p className="muted" style={{ marginTop: 10 }}>
        <FiatEstimate
          amountSmallestUnit={invoice.amount}
          currency={invoice.currency}
        />{" "}
        Estimate only, not the settlement rate.
      </p>

      <hr className="rule" />
      <h3 style={{ margin: "0 0 4px" }}>Where this invoice stands</h3>
      <p className="sub">{statusExplainer}</p>
      <InvoiceTimeline invoice={invoice} />

      {error && <div className="error" role="alert">{error}</div>}
      {done && <div className="notice" aria-live="polite">{done}</div>}
      {txHash && (
        <p className="muted">
          Transaction:{" "}
          <a
            href={`${EXPLORER_URL}/transactions/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {txHash}
          </a>
        </p>
      )}
      {(done || txHash) && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-ghost" onClick={load} disabled={busy}>
            Refresh status
          </button>
        </div>
      )}

      <hr className="rule" />
      <div className="row">
        {invoice.status === "Pending" && isClient && !isUsdc && (
          <button
            className="btn"
            disabled={busy}
            onClick={handlePay}
          >
            {busy ? (
              "Waiting for wallet…"
            ) : (
              <>
                Pay {formatNear(invoice.amount)}{" "}
                <CurrencyIcon currency="Near" />
              </>
            )}
          </button>
        )}
        {invoice.status === "Pending" && isClient && isUsdc && (
          <p className="muted" style={{ margin: 0 }}>
            This is a USDC invoice. It settles via 1Click straight to
            the seller (no escrow). Use the 1Click payment below. The
            escrow button does not apply here because the contract
            cannot hold USDC.
          </p>
        )}
        {invoice.status === "Paid" && !invoice.released && isSeller && !invoice.disputed && (
          <>
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => releaseInvoice(invoice.id), "Release")}
            >
              Release to me
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => run(() => refundInvoice(invoice.id), "Refund")}
            >
              Refund client
            </button>
          </>
        )}
        {invoice.status === "Paid" && !invoice.released && isSeller && invoice.disputed && (
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => run(() => refundInvoice(invoice.id), "Refund")}
          >
            Refund client (dispute open)
          </button>
        )}
        {invoice.status === "Pending" && isSeller && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => run(() => cancelInvoice(invoice.id), "Cancellation")}
          >
            Cancel invoice
          </button>
        )}
        {invoice.status === "Pending" && !isClient && !isSeller && (
          <p className="muted">
            Only the client ({invoice.client}) can pay this invoice.
            Connect with that account to pay.
          </p>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => downloadInvoicePdf(invoice)}
        >
          Download PDF
        </button>
        <CopyButton text={shareUrl} label="Copy pay link" />
        <CopyButton
          text={reminderText}
          label="Copy reminder"
          copiedLabel="Reminder copied ✓"
        />
      </div>

      {invoice.status === "Paid" && !invoice.released && isClient && (
        <>
          <hr className="rule" />
          <h3 style={{ margin: "0 0 4px" }}>Dispute or claim a refund</h3>
          {!invoice.disputed ? (
            <>
              <p className="sub">
                If the work was not delivered, open a dispute. It blocks
                the seller from releasing the escrow until you withdraw it
                or the seller refunds you.
              </p>
              <label htmlFor="disputeReason">Reason (max 200 bytes)</label>
              <input
                id="disputeReason"
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="e.g. work not delivered"
                autoComplete="off"
              />
              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="btn btn-ghost"
                  disabled={busy || !disputeReason.trim()}
                  onClick={() =>
                    run(() => openDispute(invoice.id, disputeReason.trim()), "Dispute")
                  }
                >
                  Open dispute
                </button>
                {pastDue && (
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => run(() => claimRefund(invoice.id), "Refund claim")}
                  >
                    Claim refund (due date passed)
                  </button>
                )}
              </div>
              {!pastDue && invoice.due_date !== null && (
                <p className="muted" style={{ marginTop: 10 }}>
                  The due date has not passed yet. You can claim the refund
                  yourself after {formatDate(invoice.due_date)} if the seller
                  stays silent. Until then, a dispute blocks the release.
                </p>
              )}
              {!pastDue && invoice.due_date === null && (
                <p className="muted" style={{ marginTop: 10 }}>
                  This invoice has no due date, so you cannot claim a refund
                  after a deadline. A dispute is your only protection,
                  besides asking the seller for a refund.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="sub">
                Dispute open
                {invoice.dispute_reason
                  ? `: “${invoice.dispute_reason}”`
                  : ""}
                . The seller cannot release the escrow while it is open.
              </p>
              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => run(() => withdrawDispute(invoice.id), "Dispute withdrawal")}
                >
                  Withdraw dispute (we made peace)
                </button>
                {pastDue && (
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => run(() => claimRefund(invoice.id), "Refund claim")}
                  >
                    Claim refund (due date passed)
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      <div className="pay-share" style={{ marginTop: 18 }}>
        <PayQr url={shareUrl} />
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <p className="muted" style={{ margin: "0 0 4px" }}>
            Pay link. Share it with the client by email or chat:
          </p>
          <p className="share-link">{shareUrl}</p>
          <p className="muted" style={{ margin: "10px 0 0" }}>
            “Copy reminder” gives you a short message with the invoice
            number, amount, and this link, ready to paste.
          </p>
        </div>
      </div>

      {invoice.status === "Pending" && isClient && (
        <>
          <hr className="rule" />
          <h3 style={{ margin: "0 0 4px" }}>
            {isUsdc
              ? "Pay via 1Click: USDC"
              : "Pay from another chain: 1Click"}
          </h3>
          {oneClickBlocked ? (
            <p className="sub">
              1Click / NEAR Intents is mainnet-only and has no testnet: the
              seller ({invoice.seller}) is a testnet account, which the
              1Click API rejects.{" "}
              {isUsdc
                ? "On testnet, a USDC invoice cannot be paid through escrow either. The flow is shown here with the existing external-payment confirmation: once the payment reaches the seller off-chain, the seller closes the invoice below."
                : "On testnet, pay in NEAR directly with the button above."}
            </p>
          ) : (
            <>
              <p className="sub">
                {isUsdc ? (
                  <>
                    This is a USDC invoice. 1Click is the way to pay it. Pay
                    with {sourceLabel} from your wallet on the origin chain;
                    1Click delivers exactly{" "}
                    <InvoiceAmount invoice={invoice} /> to the seller,
                    straight to their account (no escrow).
                  </>
                ) : (
                  <>
                    Pay with {sourceLabel} from your wallet on the origin
                    chain. 1Click delivers exactly{" "}
                    {formatNear(invoice.amount)}{" "}
                    <CurrencyIcon currency="Near" /> to the seller.
                  </>
                )}
                {quote && quote.depositAddress
                  ? ` Send ${quote.amountInFormatted} to the deposit address below. The swap starts on receipt.`
                  : ""}
              </p>
              <p className="muted">
                A dry quote is a price preview only. The live price can move
                before you reserve the deposit address.
              </p>
              <p className="muted">{MAINNET_ONLY_NOTE}</p>
              {quoteError && <div className="error" role="alert">{quoteError}</div>}
              <label htmlFor="sourceAsset">Pay with</label>
              <select
                id="sourceAsset"
                value={sourceAsset}
                onChange={(e) => {
                  setSourceAsset(e.target.value);
                  setQuote(null);
                  setSwapStatus(null);
                }}
              >
                {SOURCE_ASSETS.map((a) => (
                  <option key={a.assetId} value={a.assetId}>
                    {a.label}
                  </option>
                ))}
              </select>
              <label htmlFor="refundTo">Your refund address (origin chain)</label>
              <input
                id="refundTo"
                value={refundTo}
                onChange={(e) => setRefundTo(e.target.value)}
                placeholder={refundAddressPlaceholder(
                  SOURCE_ASSETS.find((a) => a.assetId === sourceAsset) ??
                    SOURCE_ASSETS[0],
                )}
                autoComplete="off"
              />
              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="btn btn-ghost"
                  disabled={quoteBusy}
                  onClick={() => requestQuote(true)}
                >
                  {quoteBusy ? "Quoting…" : "Get live quote"}
                </button>
                <button
                  className="btn"
                  disabled={quoteBusy || !quote}
                  onClick={() => requestQuote(false)}
                >
                  Reserve deposit address
                </button>
              </div>
              {quote && (
                <dl className="kv" style={{ marginTop: 16 }}>
                  <dt>You send</dt>
                  <dd>
                    {quote.amountInFormatted} {sourceLabel}
                  </dd>
                  <dt>Seller receives</dt>
                  <dd>
                    {quote.amountOutFormatted} {destinationLabel}
                  </dd>
                  <dt>Time estimate</dt>
                  <dd>~{quote.timeEstimateSec} s</dd>
                  {quote.depositAddress && (
                    <>
                      <dt>Deposit address</dt>
                      <dd style={{ wordBreak: "break-all" }}>
                        {quote.depositAddress}
                      </dd>
                      <dt>Status</dt>
                      <dd>{swapStatus?.status ?? "-"}</dd>
                    </>
                  )}
                </dl>
              )}
              {quote?.depositAddress && (
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-ghost"
                    disabled={polling}
                    onClick={pollStatus}
                  >
                    {polling ? "Polling 1Click…" : "Track settlement"}
                  </button>
                  {swapStatus?.status === "SUCCESS" && (
                    <span className="muted">
                      Settlement received. Ask the seller to confirm it below.
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {invoice.status === "Pending" && isSeller && (
        <>
          <hr className="rule" />
          <h3 style={{ margin: "0 0 4px" }}>Confirm external payment</h3>
          <p className="sub">
            {isUsdc
              ? "If the client paid via 1Click and the USDC landed in your account, close the invoice here. This records the 1Click deposit address as proof and marks the invoice Paid. Only you (the seller) can do this. This is your own attestation. Nothing on-chain verifies the payment."
              : "If the client paid from another chain via 1Click and the wNEAR landed in your account, close the invoice here. This records the 1Click deposit address as proof and marks the invoice Paid. Only you (the seller) can do this. This is your own attestation. Nothing on-chain verifies the payment."}
          </p>
          <label htmlFor="extRef">1Click deposit address / tx reference</label>
          <input
            id="extRef"
            value={extRef}
            onChange={(e) => setExtRef(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
          />
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn"
              disabled={busy || !extRef.trim()}
              onClick={() =>
                run(
                  () => confirmExternalPayment(invoice.id, extRef.trim()),
                  "External payment confirmation",
                )
              }
            >
              {busy ? "Waiting for wallet…" : "Confirm I received payment"}
            </button>
          </div>
        </>
      )}
    </div>
    </Reveal>
  );
}
