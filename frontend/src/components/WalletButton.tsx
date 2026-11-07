import { useEffect, useState } from "react";
import {
  getSignedInAccount,
  onAccountChange,
  openWalletModal,
  signOut,
} from "../lib/near";
import { EXPLORER_URL } from "../lib/config";

export default function WalletButton() {
  const [accountId, setAccountId] = useState<string | null>(null);

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

  async function handleSignOut() {
    await signOut();
    setAccountId(null);
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
    <button className="btn" onClick={openWalletModal}>
      Connect wallet
    </button>
  );
}
