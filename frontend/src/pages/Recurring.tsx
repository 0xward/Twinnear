import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  createInvoice,
  extractReturnU64,
  extractTxHash,
  formatNear,
  formatUsdc,
  friendlyError,
  getSignedInAccount,
  isAccountForNetwork,
  isValidAccountId,
  parseNearAmount,
  parseUsdcAmount,
} from "../lib/near";
import { EXPLORER_URL } from "../lib/config";
import {
  advanceDueDate,
  formatIsoDate,
  isDue,
  loadTemplates,
  newTemplateId,
  saveTemplates,
  todayIso,
} from "../lib/recurring";
import type {
  Frequency,
  RecurringTemplate,
} from "../lib/recurring";
import {
  computeInvoiceTotal,
  draftIsEmpty,
  parseLineItemDraft,
} from "../lib/invoiceMath";
import type { LineItemDraft } from "../lib/invoiceMath";
import { FREQUENCY_LABELS } from "../lib/recurring";
import type { Currency, LineItem } from "../lib/types";
import CurrencyBadge from "../components/CurrencyBadge";
import CurrencyIcon from "../components/CurrencyIcon";
import AccountNameField from "../components/AccountNameField";
import FiatEstimate from "../components/FiatEstimate";
import Reveal from "../components/Reveal";

const EMPTY_ROW: LineItemDraft = {
  description: "",
  quantity: "1",
  unitPrice: "",
};

interface GenerateResult {
  templateName: string;
  ok: boolean;
  invoiceId: number | null;
  txHash: string | null;
  error: string | null;
}

/**
 * Retainers / recurring invoices — frontend-only, localStorage.
 * There is NO cron or background job: templates live in this browser,
 * and "Generate due invoices" creates whatever is due, right now.
 * Each due invoice is ONE on-chain transaction (one wallet
 * confirmation per invoice); the next due date advances by the
 * template's frequency after a successful create.
 */
export default function Recurring() {
  const [templates, setTemplates] = useState<RecurringTemplate[]>(() =>
    loadTemplates(),
  );
  // New-template form.
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [currency, setCurrency] = useState<Currency>("Near");
  const [rows, setRows] = useState<LineItemDraft[]>([{ ...EMPTY_ROW }]);
  // Line-item errors only show once the user has touched a row (or
  // tried to save): the first row starts with quantity "1" prefilled,
  // so it is not "empty" and would otherwise error on first load.
  const [rowsTouched, setRowsTouched] = useState(false);
  const [taxPct, setTaxPct] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [nextDue, setNextDue] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<GenerateResult[]>([]);

  const parseUnitPrice =
    currency === "Usdc" ? parseUsdcAmount : parseNearAmount;
  const formatUnit = currency === "Usdc" ? formatUsdc : formatNear;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, currency]);

  const taxBps = useMemo(() => {
    const t = taxPct.trim();
    if (t === "") return 0;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return Math.round(n * 100);
  }, [taxPct]);

  const totals = useMemo(
    () => computeInvoiceTotal(parsedItems.items, taxBps === null ? 0 : taxBps),
    [parsedItems.items, taxBps],
  );

  function persist(next: RecurringTemplate[]) {
    try {
      saveTemplates(next);
      setTemplates(next);
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  function handleAddTemplate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const clientTrimmed = client.trim();
    if (!name.trim()) {
      setError("Give the retainer a name, e.g. “Monthly design retainer”.");
      return;
    }
    if (!isValidAccountId(clientTrimmed) || !isAccountForNetwork(clientTrimmed)) {
      setError(
        `"${clientTrimmed}" is not a valid testnet client account. Use a .testnet account.`,
      );
      return;
    }
    if (parsedItems.rowError) {
      setError(parsedItems.rowError);
      return;
    }
    if (parsedItems.items.length === 0) {
      setError("Add at least one line item to the retainer.");
      return;
    }
    if (taxBps === null) {
      setError("Tax must be a percentage between 0 and 100.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) {
      setError("Pick a valid next due date.");
      return;
    }
    const template: RecurringTemplate = {
      id: newTemplateId(),
      name: name.trim(),
      client: clientTrimmed,
      currency,
      items: parsedItems.items,
      taxRateBps: taxBps,
      totalSmallestUnit: totals.total,
      frequency,
      nextDue,
      active: true,
      lastGeneratedAt: null,
      generatedIds: [],
      createdAt: new Date().toISOString(),
    };
    persist([...templates, template]);
    setDone(`Retainer “${template.name}” saved.`);
    setName("");
    setClient("");
    setRows([{ ...EMPTY_ROW }]);
    setRowsTouched(false);
    setTaxPct("");
    setNextDue(todayIso());
  }

  function setRow(i: number, patch: Partial<LineItemDraft>) {
    setRowsTouched(true);
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function toggleActive(id: string) {
    persist(
      templates.map((t) => (t.id === id ? { ...t, active: !t.active } : t)),
    );
  }

  function deleteTemplate(id: string) {
    if (
      !window.confirm(
        "Delete this retainer template? Invoices already generated from it stay on-chain.",
      )
    ) {
      return;
    }
    persist(templates.filter((t) => t.id !== id));
  }

  async function generateDue() {
    setError(null);
    setDone(null);
    setResults([]);
    const account = await getSignedInAccount();
    if (!account) {
      setError("Connect your wallet first. The button is at the top.");
      return;
    }
    const due = templates.filter((t) => isDue(t));
    if (due.length === 0) {
      setDone("Nothing is due. No active retainer has reached its date.");
      return;
    }
    setBusy(true);
    const out: GenerateResult[] = [];
    const updated = [...templates];
    try {
      for (const template of due) {
        try {
          const res = await createInvoice(
            template.client,
            template.totalSmallestUnit,
            `${template.name} · ${formatIsoDate(template.nextDue)}`,
            null,
            template.currency,
            template.items,
            template.taxRateBps,
          );
          const invoiceId = extractReturnU64(res);
          out.push({
            templateName: template.name,
            ok: true,
            invoiceId,
            txHash: extractTxHash(res),
            error: null,
          });
          const idx = updated.findIndex((t) => t.id === template.id);
          if (idx >= 0) {
            updated[idx] = {
              ...updated[idx],
              nextDue: advanceDueDate(template.nextDue, template.frequency),
              lastGeneratedAt: new Date().toISOString(),
              generatedIds:
                invoiceId !== null
                  ? [...updated[idx].generatedIds, invoiceId]
                  : updated[idx].generatedIds,
            };
          }
        } catch (err) {
          out.push({
            templateName: template.name,
            ok: false,
            invoiceId: null,
            txHash: null,
            error: friendlyError(err),
          });
          // Stop on the first failure: the user may have rejected the
          // wallet prompt, and hammering the rest would only queue
          // more confirmations they did not ask for.
          break;
        }
      }
      persist(updated);
      setResults(out);
      const made = out.filter((r) => r.ok).length;
      if (made > 0) {
        setDone(
          `Generated ${made} invoice${made === 1 ? "" : "s"}. Confirm each one in your wallet, then check the ledger.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const dueCount = templates.filter((t) => isDue(t)).length;
  const unitLabel = currency === "Usdc" ? "USDC" : "NEAR";

  return (
    <div>
      <Reveal>
      <div className="card">
        <h2>Retainers</h2>
        <p className="sub">
          Recurring invoices, kept in this browser only. A retainer is a
          template: when its date arrives, press “Generate due invoices”
          and the invoice is created on-chain. There is no cron and no
          background job. Nothing is created until you press the button.
          Each due invoice is one transaction, so your wallet asks you
          to confirm each one.
        </p>
        {error && <div className="error" role="alert">{error}</div>}
        {done && <div className="notice" aria-live="polite">{done}</div>}

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="btn"
            onClick={generateDue}
            disabled={busy || dueCount === 0}
          >
            {busy
              ? "Waiting for wallet…"
              : dueCount > 0
                ? `Generate due invoices (${dueCount})`
                : "Generate due invoices"}
          </button>
          <span className="muted">
            {dueCount === 0
              ? "Nothing is due right now."
              : `${dueCount} retainer${dueCount === 1 ? " is" : "s are"} due.`}
          </span>
        </div>

        {results.length > 0 && (
          <ul className="timeline" aria-live="polite">
            {results.map((r, i) => (
              <li key={i} className={r.ok ? "done" : "next"}>
                <span className="dot" aria-hidden="true" />
                <span className="tl-label">
                  {r.templateName}:{" "}
                  {r.ok
                    ? r.invoiceId !== null
                      ? `invoice #${r.invoiceId} created`
                      : "invoice created (id unknown; check the ledger)"
                    : `failed: ${r.error}`}
                </span>
                {r.ok && r.txHash && (
                  <span className="tl-date">
                    <a
                      href={`${EXPLORER_URL}/transactions/${r.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.txHash}
                    </a>
                  </span>
                )}
                {r.ok && r.invoiceId !== null && (
                  <span className="tl-date">
                    <Link to={`/pay/${r.invoiceId}`}>
                      View invoice #{r.invoiceId}
                    </Link>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {templates.length === 0 ? (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">
              §
            </div>
            <p className="muted">
              No retainers yet. Create the first one below.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Retainer templates
              </caption>
              <thead>
                <tr>
                  <th scope="col">Retainer</th>
                  <th scope="col">Client</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Every</th>
                  <th scope="col">Next due</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.client}</td>
                    <td className="num">
                      <CurrencyBadge currency={t.currency} />{" "}
                      {t.currency === "Usdc"
                        ? formatUsdc(t.totalSmallestUnit)
                        : formatNear(t.totalSmallestUnit)}{" "}
                      <CurrencyIcon currency={t.currency} />{" "}
                      <FiatEstimate
                        amountSmallestUnit={t.totalSmallestUnit}
                        currency={t.currency}
                      />
                    </td>
                    <td>{FREQUENCY_LABELS[t.frequency]}</td>
                    <td>{formatIsoDate(t.nextDue)}</td>
                    <td>
                      {isDue(t) ? (
                        <span className="stamp stamp-pending">Due</span>
                      ) : t.active ? (
                        <span className="stamp stamp-paid">Active</span>
                      ) : (
                        <span className="stamp stamp-refunded">Paused</span>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => toggleActive(t.id)}
                        >
                          {t.active ? "Pause" : "Resume"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => deleteTemplate(t.id)}
                        >
                          Delete
                        </button>
                      </div>
                      {t.generatedIds.length > 0 && (
                        <span className="muted">
                          Generated:{" "}
                          {t.generatedIds.map((id) => (
                            <Link key={id} to={`/pay/${id}`}>
                              #{id}
                            </Link>
                          )).reduce<React.ReactNode[]>(
                            (acc, el, i) =>
                              i === 0 ? [el] : [...acc, ", ", el],
                            [],
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>New retainer</h2>
        <p className="sub">
          The template stores the line items and tax; every generated
          invoice copies them. Amounts are in the retainer&apos;s
          currency.
        </p>
        <form onSubmit={handleAddTemplate}>
          <label htmlFor="rt-name">Name</label>
          <input
            id="rt-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Monthly design retainer"
            autoComplete="off"
          />
          <AccountNameField
            id="rt-client"
            label="Client account"
            value={client}
            onChange={setClient}
            placeholder="alice.testnet"
          />
          <fieldset className="currency-toggle" aria-label="Retainer currency">
            <legend>Currency</legend>
            <label className={currency === "Near" ? "seg active" : "seg"}>
              <input
                type="radio"
                name="rt-currency"
                value="Near"
                checked={currency === "Near"}
                onChange={() => setCurrency("Near")}
              />
              NEAR · escrow
            </label>
            <label className={currency === "Usdc" ? "seg active" : "seg"}>
              <input
                type="radio"
                name="rt-currency"
                value="Usdc"
                checked={currency === "Usdc"}
                onChange={() => setCurrency("Usdc")}
              />
              USDC · via 1Click
            </label>
          </fieldset>

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
                  onChange={(e) => setRow(i, { description: e.target.value })}
                  placeholder="Design work, retainer"
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
          <label htmlFor="rt-tax">Tax (%)</label>
          <input
            id="rt-tax"
            value={taxPct}
            onChange={(e) => setTaxPct(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            autoComplete="off"
          />
          {taxBps === null && (
            <div className="error" role="alert">
              Tax must be a percentage between 0 and 100.
            </div>
          )}
          {parsedItems.items.length > 0 && (
            <dl className="kv" style={{ marginTop: 14 }}>
              <dt>Subtotal</dt>
              <dd>
                {formatUnit(totals.subtotal)}{" "}
                <CurrencyIcon currency={currency} />
              </dd>
              <dt>Tax</dt>
              <dd>
                {formatUnit(totals.taxAmount)}{" "}
                <CurrencyIcon currency={currency} />
              </dd>
              <dt>Total / period</dt>
              <dd>
                {formatUnit(totals.total)}{" "}
                <CurrencyIcon currency={currency} />{" "}
                <FiatEstimate
                  amountSmallestUnit={totals.total}
                  currency={currency}
                />
              </dd>
            </dl>
          )}

          <label htmlFor="rt-frequency">Frequency</label>
          <select
            id="rt-frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
          <label htmlFor="rt-nextDue">Next due date</label>
          <input
            id="rt-nextDue"
            type="date"
            value={nextDue}
            onChange={(e) => setNextDue(e.target.value)}
          />
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn" type="submit" disabled={busy}>
              Save retainer
            </button>
          </div>
        </form>
      </div>
      </Reveal>
    </div>
  );
}
