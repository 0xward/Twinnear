import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  STORAGE_DEPOSIT_NEAR,
  accountExists,
  createInvoice,
  extractReturnU64,
  extractTxHash,
  getOpenInvoiceCount,
  getSignedInAccount,
  isAccountForNetwork,
  isPlainDecimalAmount,
  isValidAccountId,
  listAllInvoices,
  parseNearAmount,
  friendlyError,
} from "../lib/near";
import { EXPLORER_URL } from "../lib/config";
import {
  RelayerDuplicateError,
  RelayerNotConfiguredError,
  isRelayerConfigured,
  submitMetaTransaction,
} from "../lib/relayer";

type DueChoice = "7" | "14" | "30" | "none";

export default function NewInvoice() {
  const navigate = useNavigate();
  const [client, setClient] = useState("");
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
  // "Refresh status" button instead (same pattern as Pay/Policy/
  // Deploy), and only then offer the way to the invoice list.
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
      "Invoice created — confirm it in your wallet, then press " +
        '"Refresh status" below to see it. Do not create it twice.',
    );
    setClient("");
    setAmount("");
    setDescription("");
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
        setError("Connect your wallet first — the button is at the top.");
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

  async function submitDirect(account: string, clientTrimmed: string) {
    return createInvoice(
      clientTrimmed,
      amount,
      description.trim(),
      dueDays(),
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
      setError("Connect your wallet first — the button is at the top.");
      return;
    }
    const clientTrimmed = client.trim();
    if (!isValidAccountId(clientTrimmed)) {
      setError(
        `"${clientTrimmed}" is not a valid NEAR account name (lowercase letters, digits, -, _, .).`,
      );
      return;
    }
    if (!isAccountForNetwork(clientTrimmed)) {
      setError(
        `On testnet the client must be a .testnet account — "${clientTrimmed}" cannot transact here.`,
      );
      return;
    }
    if (clientTrimmed === account) {
      setError("You cannot invoice yourself — the client must be someone else.");
      return;
    }
    if (!isPlainDecimalAmount(amount)) {
      setError("Amount must be a plain decimal number greater than zero, e.g. 1.5.");
      return;
    }
    if (descriptionTooLong) {
      setError(
        `Description is ${descriptionBytes} bytes — the contract allows at most 500 bytes.`,
      );
      return;
    }
    setBusy(true);
    try {
      // The client must exist, or the invoice can never be paid.
      if (!(await accountExists(clientTrimmed))) {
        throw new Error(
          `Client account ${clientTrimmed} does not exist on testnet — check the spelling.`,
        );
      }
      if (gasless) {
        const amountYocto = parseNearAmount(amount.trim());
        if (!amountYocto) throw new Error("Invalid amount");
        try {
          const result = await submitMetaTransaction({
            seller: account,
            client: clientTrimmed,
            amountYocto,
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
        const res = await submitDirect(account, clientTrimmed);
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
      setError("Connect your wallet first — the button is at the top.");
      return;
    }
    setBusy(true);
    try {
      const res = await submitDirect(account, client.trim());
      showCreated(extractTxHash(res), extractReturnU64(res));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>New invoice</h2>
      <p className="sub">
        You are the seller. The client pays the exact amount; funds are held
        in escrow by the contract until you release them — or refund them.
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
        <div className="notice" aria-live="polite">
          The gasless relayer failed — you can still create this invoice
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
        <label htmlFor="client">Client account</label>
        <input
          id="client"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          placeholder="alice.testnet"
          autoComplete="off"
          list="known-clients"
        />
        <datalist id="known-clients">
          {knownClients.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label htmlFor="amount">Amount (NEAR)</label>
        <input
          id="amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="1.5"
          inputMode="decimal"
          autoComplete="off"
        />
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Design work — landing page, October"
          aria-describedby="description-count"
        />
        <p
          className="muted"
          id="description-count"
          style={{ margin: "4px 0 0" }}
        >
          {descriptionBytes} / 500 bytes
          {descriptionTooLong
            ? " — too long; shorten it before creating the invoice."
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
          deposit — one-time, non-refundable; it pays for the ledger entry.
          Escrowed funds are separate: the client pays the invoice amount,
          and it returns to the client on refund.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy
              ? "Waiting for wallet…"
              : gasless
                ? "Create invoice (gasless)"
                : "Create invoice"}
          </button>
        </div>
        {isRelayerConfigured() ? (
          <p className="muted" style={{ marginTop: 12 }}>
            <label style={{ display: "inline", textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={gasless}
                onChange={(e) => setGasless(e.target.checked)}
                style={{ width: "auto", marginRight: 8 }}
              />
              Create gaslessly — a relayer submits this for you (you only
              sign a message, no gas).
            </label>
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            Gasless relay is not configured (no relayer server at
            VITE_RELAYER_URL) — you pay your own testnet gas, which is a
            fraction of a cent. See relayer-server/ to run one.
          </p>
        )}
      </form>
      <hr className="rule" />
      {(client.trim() || amount.trim() || description.trim()) && (
        <div className="preview" aria-live="polite">
          <div className="label" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-faint)", fontWeight: 600 }}>
            Preview — how the client will see it
          </div>
          <div className="preview-amount">
            {amount.trim() && Number(amount) > 0 ? `${amount.trim()} Ⓝ` : "— Ⓝ"}
          </div>
          <p className="preview-meta">
            {description.trim() || "No description yet"}
            {client.trim() ? ` · billed to ${client.trim()}` : ""}
          </p>
          <p className="preview-meta">
            Reference assigned on-chain (TW-YYYY-NNNN) · payable by NEAR or,
            on mainnet, from another chain via 1Click.
            {dueChoice === "none"
              ? " · No payment deadline."
              : ` · Due in ${dueChoice} days.`}
          </p>
        </div>
      )}
      <p className="muted" style={{ marginTop: 14 }}>
        Spend-guard: if the client set a policy (max amount per invoice, or
        an allowlist of sellers), this invoice is rejected on-chain when it
        breaks that policy. Multi-chain settlement via 1Click/Intents lives
        on the pay page (mainnet only — 1Click has no testnet); gasless
        creation via the relayer is available above when configured.
      </p>
    </div>
  );
}
