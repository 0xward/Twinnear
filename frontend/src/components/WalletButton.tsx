import { useEffect, useState } from "react";
import {
  getSignedInAccount,
  onAccountChange,
  openWalletModal,
  signOut,
  warmWalletModal,
} from "../lib/near";
import { EXPLORER_URL } from "../lib/config";

export default function WalletButton() {
  const [accountId, setAccountId] = useState<string | null>(null);
  // The first click used to sit dead for seconds while the wallet
  // chunks downloaded: show "Opening wallet…" so the wait is visible.
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    // L-01: follow wallet account changes (connect / switch / sign
    // out) instead of reading the account once at mount.
    onAccountChange((acct) => {
      if (!cancelled) setAccountId(acct);
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(() => setAccountId(null));
    getSignedInAccount()
      .then((acct) => {
        if (!cancelled) setAccountId(acct);
      })
      .catch(() => setAccountId(null));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Warm up the wallet modal when the browser is idle, so the first
  // click is fast even on a phone (no hover there to preload on).
  // The selector modules already start loading at mount above; this
  // adds only the modal-ui chunk.
  useEffect(() => {
    const win = window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleHandle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (win.requestIdleCallback) {
      idleHandle = win.requestIdleCallback(() => warmWalletModal(), {
        timeout: 4000,
      });
    } else {
      timer = setTimeout(() => warmWalletModal(), 2000);
    }
    return () => {
      if (idleHandle !== undefined) win.cancelIdleCallback?.(idleHandle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  async function handleSignOut() {
    await signOut();
    setAccountId(null);
  }

  async function handleConnect() {
    if (opening) return;
    setOpening(true);
    try {
      await openWalletModal();
    } finally {
      setOpening(false);
    }
  }

  if (accountId) {
    return (
      <span className="row">
        <span
          aria-hidden="true"
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "var(--accent)",
            flex: "none",
          }}
        />
        <a
          className="mono"
          href={`${EXPLORER_URL}/accounts/${accountId}`}
          target="_blank"
          rel="noreferrer"
          title={`View ${accountId} on the explorer`}
          style={{ fontSize: 13.5, color: "var(--ink)" }}
        >
          {accountId}
        </a>
        <button className="btn btn-ghost" onClick={handleSignOut}>
          Sign out
        </button>
      </span>
    );
  }

  return (
    <button
      className="btn"
      onClick={handleConnect}
      onMouseEnter={warmWalletModal}
      onFocus={warmWalletModal}
      disabled={opening}
    >
      {opening ? "Opening wallet…" : "Connect wallet"}
    </button>
  );
}
