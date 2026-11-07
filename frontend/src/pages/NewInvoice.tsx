import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  STORAGE_DEPOSIT_NEAR,
  accountExists,
  createInvoice,
  extractReturnU64,
  extractTxHash,
  formatNear,
  formatUsdc,
  getOpenInvoiceCount,
  getSignedInAccount,
  isAccountForNetwork,
  isPlainDecimalAmount,
  isPlainUsdcAmount,
  isValidAccountId,
  listAllInvoices,
  parseNearAmount,
  parseUsdcAmount,
  friendlyError,
} from "../lib/near";
import { EXPLORER_URL } from "../lib/config";
import {
  RelayerDuplicateError,
  RelayerNotConfiguredError,
  isRelayerConfigured,
  submitMetaTransaction,
} from "../lib/relayer";
import {
  computeInvoiceTotal,
  draftIsEmpty,
  parseLineItemDraft,
} from "../lib/invoiceMath";
import type { LineItemDraft } from "../lib/invoiceMath";
import type { Currency, LineItem } from "../lib/types";
import FiatEstimate from "../components/FiatEstimate";
import AccountNameField from "../components/AccountNameField";
import CurrencyIcon from "../components/CurrencyIcon";

type DueChoice = "7" | "14" | "30" | "none";

const EMPTY_ROW: LineItemDraft = {
  description: "",
  quantity: "1",
  unitPrice: "",
};

export default function NewInvoice() {
  const navigate = useNavigate();
  const [client, setClient] = useState("");
  const [currency, setCurrency] = useState<Currency>("Near");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [dueChoice, setDueChoice] = useState<DueChoice>("14");
  const [gasless, setGasless] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayerFailed, setRelayerFailed] = useState(false);
  // M-06: after a successful submit, do NOT navigate away immediately
  // — the transaction is not final yet and the list would not show
  // the new invoice. Show the tx hash + explorer link and a manual
  // "Refresh status" button instead (same pattern as Pay/Policy),
  // and only then offer the way to the invoice list.
  const [done, setDone] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [createdInvoiceId, setCreatedInvoiceId] = useState<number | null>(null);
  const [openCount, setOpenCount] = useState<number | null>(null);
  // Clients already invoiced, for suggestions (read-only view call).
  const [knownClients, setKnownClients] = useState<string[]>([]);
  // The contract caps the description at 500 BYTES (description.len()),
  // not 500 characters — an emoji counts as several bytes (QA L-09).
  const descriptionBytes = new TextEncoder().encode(description).length;
  const descriptionTooLong = descriptionBytes > 500;

  // ---- F2: line items + tax ----
  const [itemized, setItemized] = useState(false);
  const [rows, setRows] = useState<LineItemDraft[]>([{ ...EMPTY_ROW }]);
  // Line-item errors only show once the user has touched a row (or
  // tried to submit): the first row starts with quantity "1"
  // prefilled, so it is not "empty" and would otherwise error on
  // first load.
  const [rowsTouched, setRowsTouched] = useState(false);
  const [taxPct, setTaxPct] = useState("");

  const parseUnitPrice =
    currency === "Usdc" ? parseUsdcAmount : parseNearAmount;
  const formatUnit =
    currency === "Usdc" ? formatUsdc : formatNear;

  /** Parsed line items (valid rows only) + first row error, if any. */
  const parsedItems = useMemo(() => {
    const items: LineItem[] = [];
    let rowError: string | null = null;
    rows.forEach((row, i) => {
      if (draftIsEmpty(row)) return;
      const parsed = parseLineItemDraft(row, i + 1, parseUnitPrice);
      if (parsed.error) {
        rowError = rowError ?? parsed.error;
        return;
      }
      if (parsed.item) items.push(parsed.item);
    });
    return { items, rowError };
    // parseUnitPrice changes with currency; rows/tax drive the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, currency]);

  const taxBps = useMemo(() => {
    const t = taxPct.trim();
    if (t === "") return 0;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return Math.round(n * 100);
  }, [taxPct]);

  /** Live totals from the line items (BigInt, same math as the contract). */
  const itemTotals = useMemo(
    () =>
      computeInvoiceTotal(
        parsedItems.items,
        taxBps === null ? 0 : taxBps,
      ),
    [parsedItems.items, taxBps],
  );

  /** The total the contract will assert, in the smallest unit. */
  const computedTotalSmallest: string | null = useMemo(() => {
    if (!itemized) {
      const parsed =
        currency === "Usdc"
          ? parseUsdcAmount(amount.trim())
          : parseNearAmount(amount.trim());
      return parsed;
    }
    if (parsedItems.items.length === 0) return null;
    return itemTotals.total;
  }, [itemized, amount, currency, parsedItems.items, itemTotals.total]);

  // Gasless (create_invoice_meta) only exists for single-line NEAR
  // invoices without tax — the canonical NEP-413 message has no
  // currency/items/tax fields (spec §1.4). Anything else hides the
  // checkbox and explains why.
  const gaslessAvailable =
    currency === "Near" && !itemized && taxBps === 0;
  const gaslessBlockedReason = !gaslessAvailable
    ? currency === "Usdc"
      ? "Gasless creation is only available for single-line NEAR invoices. USDC invoices are created directly."
      : "Gasless creation is only available for single-line NEAR invoices without tax. Itemized or taxed invoices are created directly."
    : null;

  useEffect(() => {
    listAllInvoices()
      .then(({ invoices }) =>
        setKnownClients([...new Set(invoices.map((i) => i.client))].sort()),
      )
      .catch(() => setKnownClients([]));
  }, []);

  useEffect(() => {
    getSignedInAccount()
      .then((acct) =>
        acct ? getOpenInvoiceCount(acct).then(setOpenCount).catch(() => {}) : {},
      )
      .catch(() => {});
  }, []);

  function dueDays(): number | null {
    return dueChoice === "none" ? null : Number(dueChoice);
  }

  /** Record a successful creation: show tx hash + explorer link and
   *  offer Refresh / View, instead of navigating away (M-06). The
   *  form is cleared so the same invoice cannot be created twice by
   *  an accidental re-submit. */
  function showCreated(hash: string | null, invoiceId: number | null) {
    setTxHash(hash);
    setCreatedInvoiceId(invoiceId);
    setDone(
      "Invoice created. Confirm it in your wallet, then press " +
        '"Refresh status" below to see it. Do not create it twice.',
    );
    setClient("");
    setAmount("");
    setDescription("");
    setRows([{ ...EMPTY_ROW }]);
    setRowsTouched(false);
    setTaxPct("");
  }

  /** Re-check the on-chain state after a submit: refresh the open
   *  count, and if the new invoice id is still unknown, find the
   *  seller's newest invoice in the list. */
  async function refreshStatus() {
    setError(null);
    setBusy(true);
    try {
      const account = await getSignedInAccount();
      if (!account) {
        setError("Connect your wallet first. The button is at the top.");
        return;
      }
      const count = await getOpenInvoiceCount(account).catch(() => null);
      if (count !== null) setOpenCount(count);
      if (createdInvoiceId === null) {
        const { invoices } = await listAllInvoices();
        const mine = invoices.filter((i) => i.seller === account);
        if (mine.length > 0) {
          setCreatedInvoiceId(Math.max(...mine.map((i) => i.id)));
        }
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Validate the form and build the exact `create_invoice` arguments.
   * Throws a plain-language Error on the first problem found.
   */
  function buildCreateArgs(account: string): {
    clientTrimmed: string;
    totalSmallest: string;
    items: LineItem[];
    taxRateBps: number;
  } {
    const clientTrimmed = client.trim();
    if (!isValidAccountId(clientTrimmed)) {
      throw new Error(
        `"${clientTrimmed}" is not a valid NEAR account name (lowercase letters, digits, -, _, .).`,
      );
    }
    if (!isAccountForNetwork(clientTrimmed)) {
      throw new Error(
        `On testnet the client must be a .testnet account. "${clientTrimmed}" cannot transact here.`,
      );
    }
    if (clientTrimmed === account) {
      throw new Error(
        "You cannot invoice yourself. The client must be someone else.",
      );
    }
    if (descriptionTooLong) {
      throw new Error(
        `Description is ${descriptionBytes} bytes. The contract allows at most 500 bytes.`,
      );
    }
    if (itemized) {
      if (parsedItems.rowError) throw new Error(parsedItems.rowError);
      if (parsedItems.items.length === 0) {
        throw new Error(
          "Add at least one line item, or switch the itemized invoice off.",
        );
      }
      if (parsedItems.items.length > 20) {
        throw new Error(
          "At most 20 line items per invoice (contract limit).",
        );
      }
      if (taxBps === null) {
        throw new Error("Tax must be a percentage between 0 and 100.");
      }
      return {
        clientTrimmed,
        totalSmallest: itemTotals.total,
        items: parsedItems.items,
        taxRateBps: taxBps,
      };
    }
    const okAmount =
      currency === "Usdc"
        ? isPlainUsdcAmount(amount)
        : isPlainDecimalAmount(amount);
    if (!okAmount) {
      throw new Error(
        currency === "Usdc"
          ? "Amount must be a plain decimal number greater than zero with at most 6 decimal places, e.g. 12.34."
          : "Amount must be a plain decimal number greater than zero, e.g. 1.5.",
      );
    }
    const totalSmallest = computedTotalSmallest;
    if (!totalSmallest) throw new Error("Invalid amount");
    return {
      clientTrimmed,
      totalSmallest,
      items: [],
      taxRateBps: 0,
    };
  }

  async function submitDirect() {
    const account = await getSignedInAccount();
    if (!account) {
      throw new Error("Connect your wallet first. The button is at the top.");
    }
    const args = buildCreateArgs(account);
    return createInvoice(
      args.clientTrimmed,
      args.totalSmallest,
      description.trim(),
      dueDays(),
      currency,
      args.items,
      args.taxRateBps,
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setTxHash(null);
    setCreatedInvoiceId(null);
    setRelayerFailed(false);
    const account = await getSignedInAccount();
    if (!account) {
      setError("Connect your wallet first. The button is at the top.");
      return;
    }
    setBusy(true);
    try {
      // The client must exist, or the invoice can never be paid.
      const args = buildCreateArgs(account);
      if (!(await accountExists(args.clientTrimmed))) {
        throw new Error(
          `Client account ${args.clientTrimmed} does not exist on testnet. Check the spelling.`,
        );
      }
      if (gasless && gaslessAvailable) {
        try {
          const result = await submitMetaTransaction({
            seller: account,
            client: args.clientTrimmed,
            amountYocto: args.totalSmallest,
            description: description.trim(),
            dueDays: dueDays(),
          });
          showCreated(result.txHash || null, result.invoiceId);
        } catch (err) {
          if (err instanceof RelayerDuplicateError) {
            // The invoice already exists — go look at it.
            navigate("/invoices");
            return;
          }
          if (err instanceof RelayerNotConfiguredError) throw err;
          // M-07: the relayer failed — offer the direct path instead
          // of leaving the user stuck.
          setRelayerFailed(true);
          throw err;
        }
      } else {
        const res = await createInvoice(
          args.clientTrimmed,
          args.totalSmallest,
          description.trim(),
          dueDays(),
          currency,
          args.items,
          args.taxRateBps,
        );
        showCreated(extractTxHash(res), extractReturnU64(res));
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDirectRetry() {
    setError(null);
    setDone(null);
    setTxHash(null);
    setCreatedInvoiceId(null);
    setRelayerFailed(false);
    const account = await getSignedInAccount();
    if (!account) {
      setError("Connect your wallet first. The button is at the top.");
      return;
    }
    setBusy(true);
    try {
      const res = await submitDirect();
      showCreated(extractTxHash(res), extractReturnU64(res));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  function setRow(i: number, patch: Partial<LineItemDraft>) {
    setRowsTouched(true);
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const amountLabel =
    currency === "Usdc" ? "Amount (USDC)" : "Amount (NEAR)";
  const unitLabel = currency === "Usdc" ? "USDC" : "NEAR";
  const previewTotal =
    computedTotalSmallest !== null ? (
      <>
        {formatUnit(computedTotalSmallest)}{" "}
        <CurrencyIcon currency={currency} />
      </>
    ) : (
      <>
        - <CurrencyIcon currency={currency} />
      </>
    );

  return (
    <div className="card">
      <h2>New invoice</h2>
      <p className="sub">
        You are the seller. The client pays the exact amount; NEAR funds
        are held in escrow by the contract until you release them or
        refund them. USDC invoices settle straight to you via 1Click,
        with no escrow.
      </p>
      {openCount !== null && (
        <p className="muted" style={{ marginTop: -6 }}>
          You have {openCount} / 50 open invoices (the contract caps open
          invoices per seller).
        </p>
      )}
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
        <div className="row" style={{ marginTop: 10, marginBottom: 14 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={refreshStatus}
            disabled={busy}
          >
            Refresh status
          </button>
          {createdInvoiceId !== null ? (
            <Link className="btn btn-ghost" to={`/pay/${createdInvoiceId}`}>
              View invoice #{createdInvoiceId}
            </Link>
          ) : (
            <Link className="btn btn-ghost" to="/invoices">
              View invoices
            </Link>
          )}
        </div>
      )}
      {relayerFailed && (
        <div className="notice-info" aria-live="polite">
          The gasless relayer failed. You can still create this invoice
          directly (you pay your own testnet gas, a fraction of a cent).{" "}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleDirectRetry}
            disabled={busy}
          >
            Create directly instead
          </button>
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <AccountNameField
          id="client"
          label="Client account"
          value={client}
          onChange={setClient}
          placeholder="alice.testnet"
          suggestions={knownClients}
        />

        <fieldset className="currency-toggle" aria-label="Invoice currency">
          <legend>Currency</legend>
          <label className={currency === "Near" ? "seg active" : "seg"}>
            <input
              type="radio"
              name="currency"
              value="Near"
              checked={currency === "Near"}
              onChange={() => setCurrency("Near")}
            />
            NEAR · escrow
          </label>
          <label className={currency === "Usdc" ? "seg active" : "seg"}>
            <input
              type="radio"
              name="currency"
              value="Usdc"
              checked={currency === "Usdc"}
              onChange={() => setCurrency("Usdc")}
            />
            USDC · via 1Click
          </label>
        </fieldset>
        {currency === "Usdc" ? (
          <p className="muted" style={{ marginTop: 8 }}>
            USDC invoices settle via 1Click to the seller (no escrow, no
            spend-guard amount cap). 1Click has no testnet. On testnet
            the flow is shown with the existing external-payment
            confirmation.
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>
            NEAR invoices are paid into escrow: the client pays the exact
            amount, and you release it or refund it. Your client&apos;s
            spend-guard rules (if any) apply.
          </p>
        )}

        {!itemized ? (
          <>
            <label htmlFor="amount">{amountLabel}</label>
            <input
              id="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={currency === "Usdc" ? "12.34" : "1.5"}
              inputMode="decimal"
              autoComplete="off"
            />
          </>
        ) : (
          <>
            <div className="label-row">
              <span className="label">Line items</span>
              <span className="muted">
                {parsedItems.items.length} item
                {parsedItems.items.length === 1 ? "" : "s"} · max 20
              </span>
            </div>
            <div className="line-items">
              <div className="line-item-head" aria-hidden="true">
                <span>Description</span>
                <span>Qty</span>
                <span>Unit price ({unitLabel})</span>
                <span />
              </div>
              {rows.map((row, i) => (
                <div className="line-item-row" key={i}>
                  <input
                    value={row.description}
                    onChange={(e) =>
                      setRow(i, { description: e.target.value })
                    }
                    placeholder="Design work, landing page"
                    aria-label={`Line item ${i + 1} description`}
                    autoComplete="off"
                  />
                  <input
                    value={row.quantity}
                    onChange={(e) => setRow(i, { quantity: e.target.value })}
                    placeholder="1"
                    inputMode="numeric"
                    aria-label={`Line item ${i + 1} quantity`}
                    autoComplete="off"
                  />
                  <input
                    value={row.unitPrice}
                    onChange={(e) => setRow(i, { unitPrice: e.target.value })}
                    placeholder={currency === "Usdc" ? "12.34" : "1.5"}
                    inputMode="decimal"
                    aria-label={`Line item ${i + 1} unit price in ${unitLabel}`}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => {
                      setRowsTouched(true);
                      setRows((prev) =>
                        prev.length > 1
                          ? prev.filter((_, j) => j !== i)
                          : [{ ...EMPTY_ROW }],
                      );
                    }}
                    disabled={rows.length === 1 && draftIsEmpty(row)}
                    aria-label={`Remove line item ${i + 1}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => {
                  setRowsTouched(true);
                  setRows((prev) => [...prev, { ...EMPTY_ROW }]);
                }}
                disabled={rows.length >= 20}
              >
                + Add line
              </button>
            </div>
            {rowsTouched && parsedItems.rowError && (
              <div className="error" role="alert" style={{ marginTop: 12 }}>
                {parsedItems.rowError}
              </div>
            )}
            <label htmlFor="taxPct">Tax (%)</label>
            <input
              id="taxPct"
              value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
              placeholder="0"
              inputMode="decimal"
              autoComplete="off"
              aria-describedby="tax-note"
            />
            <p className="muted" id="tax-note" style={{ marginTop: 6 }}>
              0–100%. Tax = subtotal × rate, rounded down to the smallest
              unit. Same math the contract enforces on-chain.
            </p>
            {taxBps === null && (
              <div className="error" role="alert">
                Tax must be a percentage between 0 and 100.
              </div>
            )}
          </>
        )}

        <p className="muted" style={{ marginTop: 12 }}>
          <label
            style={{
              display: "inline",
              textTransform: "none",
              letterSpacing: 0,
              fontSize: 14,
              fontWeight: 400,
            }}
          >
            <input
              type="checkbox"
              checked={itemized}
              onChange={(e) => {
                setItemized(e.target.checked);
                if (e.target.checked && gasless) setGasless(false);
              }}
              style={{ width: "auto", marginRight: 8 }}
            />
            Itemized invoice: line items + tax instead of one amount.
          </label>
        </p>

        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Design work, landing page, October"
          aria-describedby="description-count"
        />
        <p
          className="muted"
          id="description-count"
          style={{ margin: "4px 0 0" }}
        >
          {descriptionBytes} / 500 bytes
          {descriptionTooLong
            ? ". Too long; shorten it before creating the invoice."
            : ""}
        </p>
        <label htmlFor="dueDays">Payment deadline</label>
        <select
          id="dueDays"
          value={dueChoice}
          onChange={(e) => setDueChoice(e.target.value as DueChoice)}
        >
          <option value="7">7 days</option>
          <option value="14">14 days (recommended)</option>
          <option value="30">30 days</option>
          <option value="none">No deadline</option>
        </select>
        {dueChoice === "none" && (
          <p className="muted" style={{ marginTop: 6 }}>
            Warning: without a deadline the client has no way to claim a
            refund if you go silent. Prefer 14 days.
          </p>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          Creating this invoice locks a {STORAGE_DEPOSIT_NEAR} NEAR storage
          deposit. One-time, non-refundable. It pays for the ledger entry.
          Escrowed funds are separate: the client pays the invoice amount,
          and it returns to the client on refund.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy
              ? "Waiting for wallet…"
              : gasless && gaslessAvailable
                ? "Create invoice (gasless)"
                : "Create invoice"}
          </button>
        </div>
        {isRelayerConfigured() ? (
          gaslessAvailable ? (
            <p className="muted" style={{ marginTop: 12 }}>
              <label style={{ display: "inline", textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={gasless}
                  onChange={(e) => setGasless(e.target.checked)}
                  style={{ width: "auto", marginRight: 8 }}
                />
                Create gaslessly: a relayer submits this for you (you only
                sign a message, no gas).
              </label>
            </p>
          ) : (
            <p className="muted" style={{ marginTop: 12 }}>
              {gaslessBlockedReason}
            </p>
          )
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            Gasless relay is not configured (no relayer server at
            VITE_RELAYER_URL). You pay your own testnet gas, which is a
            fraction of a cent. See relayer-server/ to run one.
          </p>
        )}
      </form>
      <hr className="rule" />
      {(client.trim() || amount.trim() || description.trim() || itemized) && (
        <div className="preview" aria-live="polite">
          <div className="label" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-faint)", fontWeight: 600 }}>
            Preview: how the client will see it
          </div>
          <div className="preview-amount">
            {previewTotal}
          </div>
          {itemized && parsedItems.items.length > 0 && (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Subtotal</dt>
              <dd>
                {formatUnit(itemTotals.subtotal)}{" "}
                <CurrencyIcon currency={currency} />
              </dd>
              <dt>Tax ({taxBps === null ? "?" : (taxBps / 100).toString()}%)</dt>
              <dd>
                {formatUnit(itemTotals.taxAmount)}{" "}
                <CurrencyIcon currency={currency} />
              </dd>
              <dt>Total</dt>
              <dd>
                {formatUnit(itemTotals.total)}{" "}
                <CurrencyIcon currency={currency} />
              </dd>
            </dl>
          )}
          <p className="preview-meta">
            {description.trim() || "No description yet"}
            {client.trim() ? ` · billed to ${client.trim()}` : ""}
          </p>
          <p className="preview-meta">
            Reference assigned on-chain (TW-YYYY-NNNN) ·{" "}
            {currency === "Usdc"
              ? "payable via 1Click on mainnet; on testnet, confirmed as an external payment."
              : "payable by NEAR or, on mainnet, from another chain via 1Click."}
            {dueChoice === "none"
              ? " · No payment deadline."
              : ` · Due in ${dueChoice} days.`}
          </p>
          {computedTotalSmallest !== null && (
            <p className="preview-meta">
              <FiatEstimate
                amountSmallestUnit={computedTotalSmallest}
                currency={currency}
              />{" "}
              Estimate only, not the settlement rate.
            </p>
          )}
        </div>
      )}
      <p className="muted" style={{ marginTop: 14 }}>
        Spend-guard: if the client set a policy (max amount per invoice, or
        an allowlist of sellers), a NEAR invoice is rejected on-chain when
        it breaks that policy. USDC invoices skip the amount and daily
        caps (different units) but the seller allowlist still applies.
        Multi-chain settlement via 1Click/Intents lives on the pay page
        (mainnet only; 1Click has no testnet). Gasless creation via the
        relayer is available above when configured.
      </p>
    </div>
  );
}
