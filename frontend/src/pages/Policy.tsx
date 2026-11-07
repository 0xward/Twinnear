import { useCallback, useEffect, useState } from "react";
import {
  extractTxHash,
  formatNear,
  friendlyError,
  getPolicy,
  getSignedInAccount,
  isAccountForNetwork,
  isPlainDecimalAmount,
  isValidAccountId,
  setPolicy,
} from "../lib/near";
import type { Policy } from "../lib/types";
import { EXPLORER_URL } from "../lib/config";

/**
 * Spend-guard settings — the rule-based policy an account sets for
 * itself. The contract enforces it in create_invoice AND re-checks it
 * in pay_invoice (max per invoice, allowlist, daily total cap). No AI
 * anywhere; these are plain rules.
 */
export default function PolicyPage() {
  const [account, setAccount] = useState<string | null>(null);
  const [current, setCurrent] = useState<Policy | null>(null);
  const [maxAmount, setMaxAmount] = useState("");
  const [maxTotalPerDay, setMaxTotalPerDay] = useState("");
  const [sellers, setSellers] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const acct = await getSignedInAccount();
      setAccount(acct);
      if (acct) {
        const policy = await getPolicy(acct);
        setCurrent(policy);
        if (policy) {
          setMaxAmount(
            policy.max_amount === "0" ? "" : formatNear(policy.max_amount),
          );
          setMaxTotalPerDay(
            policy.max_total_per_day === "0"
              ? ""
              : formatNear(policy.max_total_per_day),
          );
          setSellers(policy.allowed_sellers.join("\n"));
        }
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

  function parseSellers(raw: string): string[] {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setTxHash(null);
    if (!account) {
      setError("Connect your wallet first — the button is at the top.");
      return;
    }
    const value = maxAmount.trim();
    if (
      value !== "" &&
      (!isPlainDecimalAmount(value) || Number(value) < 0)
    ) {
      setError(
        "Max amount must be a plain decimal number (e.g. 1.5), or empty for no limit.",
      );
      return;
    }
    const daily = maxTotalPerDay.trim();
    if (
      daily !== "" &&
      (!isPlainDecimalAmount(daily) || Number(daily) < 0)
    ) {
      setError(
        "Max total per day must be a plain decimal number (e.g. 5), or empty for no limit.",
      );
      return;
    }
    const allowed = parseSellers(sellers);
    const deduped = [...new Set(allowed)];
    for (const s of deduped) {
      if (!isValidAccountId(s)) {
        setError(`"${s}" is not a valid NEAR account name.`);
        return;
      }
      if (!isAccountForNetwork(s)) {
        setError(
          `"${s}" is not a testnet account — on testnet, sellers must end in .testnet.`,
        );
        return;
      }
    }
    setBusy(true);
    try {
      // H-07: setPolicy throws on an unparseable amount instead of
      // silently storing "no limit".
      const res = await setPolicy(value, deduped, daily);
      setTxHash(extractTxHash(res));
      setDone(
        "Policy submitted — confirm it in your wallet, then press \"Refresh\" below to see the result.",
      );
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const rulesActive =
    !!current &&
    (current.max_amount !== "0" ||
      current.max_total_per_day !== "0" ||
      current.allowed_sellers.length > 0);

  if (loading) {
    return (
      <div className="card">
        <p className="muted">Loading your policy…</p>
      </div>
    );
  }

  return (
    <div>
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Protection</div>
          <div className="value amount" style={{ fontSize: 22 }}>
            {account
              ? rulesActive
                ? "Active"
                : "No rules"
              : "—"}
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            {account
              ? rulesActive
                ? "Invoices breaking a rule are rejected on-chain"
                : "Any invoice can charge this account"
              : "Connect to see your policy"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Max per invoice</div>
          <div className="value amount" style={{ fontSize: 22 }}>
            {current && current.max_amount !== "0"
              ? `${formatNear(current.max_amount)} Ⓝ`
              : "No limit"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Max total per day</div>
          <div className="value amount" style={{ fontSize: 22 }}>
            {current && current.max_total_per_day !== "0"
              ? `${formatNear(current.max_total_per_day)} Ⓝ`
              : "No limit"}
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            {current && current.max_total_per_day !== "0"
              ? `Spent today: ${formatNear(current.daily_spent)} Ⓝ`
              : "no daily cap set"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Allowed sellers</div>
          <div className="value amount" style={{ fontSize: 22 }}>
            {current && current.allowed_sellers.length > 0
              ? current.allowed_sellers.length
              : "Any"}
          </div>
          <div className="label" style={{ marginTop: 2 }}>
            {current && current.allowed_sellers.length > 0
              ? "seller(s) on the allowlist"
              : "no allowlist set"}
          </div>
        </div>
      </div>

      <div className="card">
      <h2>Spend guard</h2>
      <p className="sub">
        Rules you set for yourself. Any invoice that breaks them is rejected
        on-chain — no AI, no judgement calls, just the rules below.
      </p>

      {account ? (
        <dl className="kv">
          <dt>Account</dt>
          <dd>{account}</dd>
          <dt>Current limit</dt>
          <dd>
            {current && current.max_amount !== "0"
              ? `${formatNear(current.max_amount)} Ⓝ per invoice`
              : "No limit"}
          </dd>
          <dt>Daily cap</dt>
          <dd>
            {current && current.max_total_per_day !== "0"
              ? `${formatNear(current.max_total_per_day)} Ⓝ per day (${formatNear(current.daily_spent)} Ⓝ spent today)`
              : "No daily cap"}
          </dd>
          <dt>Allowlist</dt>
          <dd>
            {current && current.allowed_sellers.length > 0
              ? current.allowed_sellers.join(", ")
              : "Any seller allowed"}
          </dd>
        </dl>
      ) : (
        <p className="muted">
          Connect your wallet to view and change your spend-guard policy.
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
      {done && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-ghost" onClick={load} disabled={busy}>
            Refresh
          </button>
        </div>
      )}

      <div className="notice" style={{ marginTop: 18 }} aria-live="polite">
        <strong>How this guard works.</strong> The rules are checked when
        an invoice is <em>created</em> AND again when you <em>pay</em> — an
        invoice created before you set a policy can no longer be paid once
        it breaks your current rules. A daily total cap also applies to
        escrow payments (it resets at midnight UTC; editing these settings
        never resets today&apos;s spent amount). Payments from another
        chain via 1Click are <em>not</em> covered: the contract never sees
        that money, so it cannot enforce a limit on it — and external
        payments do not count toward your daily cap either.
      </div>

      <hr className="rule" />
      <form onSubmit={handleSubmit}>
        <label htmlFor="maxAmount">Max amount per invoice (NEAR)</label>
        <input
          id="maxAmount"
          value={maxAmount}
          onChange={(e) => setMaxAmount(e.target.value)}
          placeholder="Leave empty for no limit"
          inputMode="decimal"
          autoComplete="off"
        />
        <label htmlFor="maxTotalPerDay">Max total per day (NEAR)</label>
        <input
          id="maxTotalPerDay"
          value={maxTotalPerDay}
          onChange={(e) => setMaxTotalPerDay(e.target.value)}
          placeholder="Leave empty for no daily cap"
          inputMode="decimal"
          autoComplete="off"
        />
        <label htmlFor="sellers">Allowed sellers (one per line)</label>
        <textarea
          id="sellers"
          value={sellers}
          onChange={(e) => setSellers(e.target.value)}
          placeholder={"alice.testnet\nbob.testnet\n\nLeave empty to allow any seller."}
          autoComplete="off"
        />
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn" type="submit" disabled={busy || !account}>
            {busy ? "Waiting for wallet…" : "Save policy"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy || !account}
            onClick={() => {
              if (
                !window.confirm(
                  "Remove your spend-guard rules? This clears the max amount " +
                    "per invoice, the daily cap, and the seller allowlist. Saving afterwards " +
                    "leaves this account with no protection at all.",
                )
              ) {
                return;
              }
              setMaxAmount("");
              setMaxTotalPerDay("");
              setSellers("");
            }}
          >
            Clear rules
          </button>
        </div>
      </form>
      <p className="muted" style={{ marginTop: 14 }}>
        “Clear rules” empties all three fields — saving then removes your
        limit, daily cap, and allowlist entirely.
      </p>
      </div>
    </div>
  );
}
