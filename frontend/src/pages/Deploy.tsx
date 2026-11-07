import { useCallback, useEffect, useState } from "react";
import {
  deployContract,
  formatNear,
  friendlyError,
  getAccountBalance,
  getOwner,
  getSignedInAccount,
  getVersion,
  isContractDeployed,
  onAccountChange,
  redeployContract,
} from "../lib/near";
import { CONTRACT_ID, EXPECTED_WASM_SHA256, EXPLORER_URL } from "../lib/config";

/**
 * Browser deploy helper — deploys the Twinnear contract to
 * twinnear.testnet from this page, signed in the user's own wallet
 * (Meteor holds the account's full-access key). No keys ever leave the
 * wallet; the wasm file is picked from the user's disk.
 *
 * ⚠️ BROWSER DEPLOY IS BLOCKED BY METEOR: Meteor Wallet refuses the
 * DeployContract action ("Contract deployment blocked"). The form
 * below stays for other wallets / in case that policy changes, but
 * the recommended path is near-cli-rs from a computer or Termux —
 * see DEPLOY.md Path B. The v1 contract was deployed that way
 * (2026-11-07, via Termux).
 *
 * Storage note: the optimized ~194 KB wasm needs ~1.9 NEAR of storage
 * stake on the account (1 NEAR per 100 KB). The page shows the
 * account's LIVE balance before you deploy (M-05), so this comment
 * cannot go stale.
 *
 * Redeploy (upgrade): deploy the new wasm WITHOUT init (`new` would
 * wipe the ledger — never call it again after the first deploy),
 * then run the owner-only `migrate` from the CLI (see DEPLOY.md).
 */
export default function Deploy() {
  const [account, setAccount] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [fileSha, setFileSha] = useState("");
  const [code, setCode] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [hashMismatch, setHashMismatch] = useState(false);

  const check = useCallback(async () => {
    setError(null);
    try {
      setAccount(await getSignedInAccount());
      // M-05: live balance, so the "holds 4 NEAR" copy can never go stale.
      try {
        const bal = await getAccountBalance(CONTRACT_ID);
        setBalance(bal.availableYocto);
      } catch {
        setBalance(null);
      }
      // H-01: only report deployed once getOwner() actually answers.
      // An account that merely exists (funded, no code) is NOT deployed.
      const codeDeployed = await isContractDeployed();
      if (!codeDeployed) {
        setDeployed(false);
        setOwner(null);
        setVersion(null);
        return;
      }
      try {
        setOwner(await getOwner());
        setDeployed(true);
        setVersion(await getVersion());
      } catch {
        setDeployed(false);
        setOwner(null);
        setVersion(null);
      }
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    // Follow wallet account changes (connect / switch / sign out) live,
    // like the header does. Without this the page only knows the account
    // from its first load and tells an already-connected wallet to
    // "connect first".
    let unsubscribe: (() => void) | null = null;
    onAccountChange((acct) => setAccount(acct))
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(() => undefined);
    return () => {
      unsubscribe?.();
    };
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setError(null);
    setDone(null);
    setTxHash(null);
    if (!file) return;
    if (!file.name.endsWith(".wasm")) {
      setError("Pick the compiled contract file, twinnear.wasm.");
      return;
    }
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    setFileName(file.name);
    setFileSize(buf.byteLength);
    setFileSha(hex);
    // M-05: warn when the file is not the build this repo produced —
    // a wrong or stale wasm must never deploy silently.
    setHashMismatch(hex !== EXPECTED_WASM_SHA256);
    setCode(new Uint8Array(buf));
  }

  /** Shared pre-flight checks for both deploy buttons. */
  function preflight(): string | null {
    if (!account) {
      return "Connect your wallet first — the button is at the top.";
    }
    if (account !== CONTRACT_ID) {
      return (
        `You are signed in as ${account}. Deploying to ${CONTRACT_ID} ` +
        `needs that exact account — switch wallets and try again.`
      );
    }
    if (!code) {
      return "Pick twinnear.wasm first (build it with: cd contract && ./build-optimized.sh).";
    }
    // M-05: pre-flight balance check — the page already computes the
    // storage stake, so compare it against the live balance instead
    // of letting the wallet fail with a generic error (and burn gas).
    const stakeYocto = BigInt(Math.ceil((fileSize / 100_000) * 1e24));
    if (balance !== null && BigInt(balance) < stakeYocto) {
      return (
        `Not enough NEAR to deploy: this file locks ≈${(fileSize / 100_000).toFixed(2)} NEAR ` +
        `for code storage, but ${CONTRACT_ID} has ${formatNear(balance)} NEAR available. ` +
        "Top up from the testnet faucet first (see DEPLOY.md)."
      );
    }
    return null;
  }

  async function handleDeploy() {
    setError(null);
    setDone(null);
    setTxHash(null);
    const problem = preflight();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const res = (await deployContract(code!)) as {
        transaction?: { hash?: string };
      };
      const hash = res?.transaction?.hash ?? null;
      setTxHash(hash);
      setDone(
        "Deploy transaction submitted — confirm it in your wallet, wait a few seconds, then press Verify below. Do not deploy twice.",
      );
      // M-06: no automatic re-check — the transaction is not final
      // yet, and an early check would show a scary getOwner() error.
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRedeploy() {
    setError(null);
    setDone(null);
    setTxHash(null);
    const problem = preflight();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const res = (await redeployContract(code!)) as {
        transaction?: { hash?: string };
      };
      const hash = res?.transaction?.hash ?? null;
      setTxHash(hash);
      setDone(
        "New code submitted (DeployContract only — no init, state is untouched). " +
          "Now run the owner-only `migrate` from the CLI (see the commands below), " +
          "then press Verify — get_version must read 2.",
      );
      // M-06: no automatic re-check — the transaction is not final yet.
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Deploy contract</h2>
      <p className="sub">
        Deploy the Twinnear contract to <code>{CONTRACT_ID}</code> from this
        page, signed in your own wallet. No keys leave your wallet.
      </p>

      <div className="error" role="alert">
        <strong>Browser deploy via Meteor is BLOCKED.</strong> Meteor
        Wallet refuses the DeployContract action (“Contract deployment
        blocked”). Recommended: near-cli-rs from a computer or Termux —
        see DEPLOY.md Path B. The form below stays for other wallets, or
        if Meteor changes its policy.
      </div>

      <dl className="kv">
        <dt>Contract</dt>
        <dd>{CONTRACT_ID}</dd>
        <dt>Status</dt>
        <dd>
          {deployed === null
            ? "Checking…"
            : deployed
              ? `Deployed${owner ? ` — owner ${owner}` : ""}${version !== null ? ` — schema v${version}` : ""}`
              : "Not deployed yet"}
        </dd>
        <dt>Signed in as</dt>
        <dd>{account ?? "Not connected"}</dd>
        <dt>Balance ({CONTRACT_ID})</dt>
        <dd>
          {balance === null
            ? "Checking…"
            : `${formatNear(balance)} NEAR available`}
        </dd>
      </dl>

      <ol className="steps" aria-label="Deployment steps">
        <li className={account ? "done" : ""}>
          Connect your wallet
          <span className="step-note">{account ?? "not connected"}</span>
        </li>
        <li className={code ? "done" : ""}>
          Choose the compiled twinnear.wasm
          <span className="step-note">
            {code ? `${(fileSize / 1024).toFixed(1)} KB` : "no file yet"}
          </span>
        </li>
        <li className={deployed === true ? "done" : ""}>
          Deploy + initialize (first deploy only — one transaction)
          <span className="step-note">
            {deployed === true ? "done" : "waiting"}
          </span>
        </li>
        <li className={deployed === true ? "done" : ""}>
          Verify on the explorer
          <span className="step-note">
            {deployed === true ? "live" : "waiting"}
          </span>
        </li>
      </ol>

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

      <hr className="rule" />
      <label htmlFor="wasm">Contract file (twinnear.wasm)</label>
      <input
        id="wasm"
        type="file"
        accept=".wasm"
        onChange={handleFile}
      />
      {code && (
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>File</dt>
          <dd>
            {fileName} ({(fileSize / 1024).toFixed(1)} KB)
          </dd>
          <dt>SHA-256</dt>
          <dd style={{ wordBreak: "break-all" }}>{fileSha}</dd>
          <dt>Storage stake</dt>
          <dd>
            ≈ {(fileSize / 100_000).toFixed(2)} NEAR locked for code
            storage (1 NEAR per 100 KB)
          </dd>
        </dl>
      )}
      {code && hashMismatch && (
        <div className="error" role="alert" style={{ marginTop: 12 }}>
          Warning: this file&apos;s SHA-256 does not match the current
          build ({EXPECTED_WASM_SHA256.slice(0, 12)}…). It may be stale
          or built from different source — deploy only if you built it
          yourself on purpose. (The expected hash is updated by the
          coordinator when a new contract build lands.)
        </div>
      )}

      {deployed === false && (
        <>
          <div className="row" style={{ marginTop: 18 }}>
            <button
              className="btn"
              onClick={handleDeploy}
              disabled={busy || !code}
            >
              {busy ? "Waiting for wallet…" : "Deploy + initialize"}
            </button>
            <button className="btn btn-ghost" onClick={check} disabled={busy}>
              Verify
            </button>
          </div>
          <p className="muted" style={{ marginTop: 14 }}>
            First deploy only: one transaction with two actions —
            DeployContract, then init <code>new</code> with owner{" "}
            <code>{CONTRACT_ID}</code>. The wallet must hold the
            full-access key of {CONTRACT_ID} (created in Meteor).
            Prefer the terminal instead? See DEPLOY.md for the
            near-cli-rs commands.
          </p>
        </>
      )}

      {deployed === true && (
        <>
          <h3 style={{ margin: "18px 0 4px" }}>Redeploy (upgrade)</h3>
          <p className="sub">
            The contract is already live. To upgrade it: deploy the new
            wasm <em>without</em> initializing — the existing state and
            owner survive — then run the owner-only <code>migrate</code>{" "}
            from the CLI. <strong>Never call <code>new</code> again</strong>{" "}
            after a redeploy: it would wipe the ledger.
          </p>
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn"
              onClick={handleRedeploy}
              disabled={busy || !code}
            >
              {busy ? "Waiting for wallet…" : "Redeploy code only (no init)"}
            </button>
            <button className="btn btn-ghost" onClick={check} disabled={busy}>
              Verify
            </button>
          </div>
          <p className="muted" style={{ marginTop: 14 }}>
            After the redeploy lands, migrate the state from the CLI
            (Termux, Ubuntu). The redeploy command takes no
            prepaid-gas/attached-deposit arguments:
          </p>
          <pre className="cli-block">
{`near contract deploy twinnear.testnet use-file twinnear.wasm without-init-call network-config testnet sign-with-legacy-keychain send

near contract call-function as-transaction twinnear.testnet migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as twinnear.testnet network-config testnet sign-with-legacy-keychain send

near contract call-function as-read-only twinnear.testnet get_version json-args '{}' network-config testnet now   # → 2`}
          </pre>
          <p className="muted" style={{ marginTop: 14 }}>
            The contract is live.{" "}
            <a
              href={`${EXPLORER_URL}/accounts/${CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              View {CONTRACT_ID} on the explorer
            </a>
            . Full commands, including the Termux setup, are in DEPLOY.md.
          </p>
        </>
      )}
    </div>
  );
}
