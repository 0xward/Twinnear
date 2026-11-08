/**
 * Funded milestones + programmable splits (contract v5): the shared
 * checklist shown on the pay page, the public invoice page, and the
 * client portal.
 *
 * Each milestone shows its state and amount, the 14-day window in
 * plain words, and the per-role action for whoever is signed in
 * (seller: Submit work / Claim; client: Approve / Ask for changes).
 * When no account is signed in (public view) it is read-only. When
 * the invoice has no milestones and no splits it renders nothing —
 * plain invoices keep exactly the page they had before.
 *
 * The whole-invoice Release / Refund buttons on the pay page keep
 * working with milestones: release pays out every part that is still
 * waiting at once, and a refund returns only the parts that have not
 * been released yet. That is stated below so nobody is surprised.
 */
import { useCallback, useEffect, useState } from "react";
import {
  approveMilestone,
  claimMilestone,
  formatDate,
  formatNear,
  friendlyError,
  getMilestones,
  getSplits,
  requestChanges,
  submitWork,
} from "../lib/near";
import {
  computeSplitShares,
  milestoneStampClass,
  milestoneStateLabel,
  windowDaysLeft,
  windowHasPassed,
  claimableAtNs,
} from "../lib/milestones";
import type { Invoice, Milestone, SplitShare } from "../lib/types";
import CurrencyIcon from "./CurrencyIcon";

function SplitBreakdown({
  amountYocto,
  splits,
  seller,
  label,
}: {
  amountYocto: string;
  splits: SplitShare[];
  seller: string;
  label: string;
}) {
  const shares = computeSplitShares(amountYocto, splits, seller);
  return (
    <p className="muted" style={{ margin: "6px 0 0" }}>
      {label}{" "}
      {shares.map((s, i) => (
        <span key={s.account}>
          {i > 0 ? ", " : ""}
          {s.percent}% to {s.account} ({formatNear(s.amountYocto)}{" "}
          <CurrencyIcon currency="Near" />)
        </span>
      ))}
      .
    </p>
  );
}

function MilestoneRow({
  invoice,
  milestone,
  index,
  account,
  splits,
  onChanged,
}: {
  invoice: Invoice;
  milestone: Milestone;
  index: number;
  account: string | null;
  splits: SplitShare[];
  onChanged: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSeller = account === invoice.seller;
  const isClient = account === invoice.client;
  const isPaid = invoice.status === "Paid";
  const daysLeft = windowDaysLeft(milestone.submitted_at);
  const claimableAt = claimableAtNs(milestone.submitted_at);

  async function act(fn: () => Promise<unknown>, label: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReason("");
      try {
        // Wait for the milestone list to finish reloading before
        // re-enabling the buttons: the rows still show the old state
        // until then, and a fast second tap would re-submit an action
        // the contract has already applied (and rightly rejects).
        await onChanged();
      } catch {
        // A reload hiccup must not masquerade as a failed action.
      }
    } catch (e) {
      setError(`${label} failed: ${friendlyError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="milestone-check-row">
      <div className="milestone-check-head">
        <span>
          <strong>
            {index + 1}. {milestone.description}
          </strong>
        </span>
        <span className="num">
          {formatNear(milestone.amount)}{" "}
          <CurrencyIcon currency="Near" />
        </span>
        <span className={milestoneStampClass(milestone.state)}>
          {milestoneStateLabel(milestone.state)}
        </span>
      </div>

      {milestone.state === "Pending" && (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Work has not been sent yet.
        </p>
      )}
      {milestone.state === "Submitted" && milestone.submitted_at !== null && (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Sent for review on {formatDate(milestone.submitted_at)}.{" "}
          {daysLeft > 0
            ? `The client has ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to reply, until ${claimableAt !== null ? formatDate(claimableAt) : ""}. If they stay silent, the seller can claim this after that date.`
            : "14 days have passed with no reply. The seller can claim this now."}
        </p>
      )}
      {milestone.state === "ChangesRequested" && (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          The client asked for changes
          {milestone.change_reason ? `: “${milestone.change_reason}”.` : "."}{" "}
          Send the work again when it is ready.
        </p>
      )}
      {milestone.state === "Released" && (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Released.
        </p>
      )}

      {splits.length > 0 && milestone.state !== "Released" && (
        <SplitBreakdown
          amountYocto={milestone.amount}
          splits={splits}
          seller={invoice.seller}
          label="When this part is released, it is shared:"
        />
      )}

      {error && (
        <div className="error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      {isPaid && isSeller &&
        (milestone.state === "Pending" ||
          milestone.state === "ChangesRequested") && (
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-ghost btn-small"
              disabled={busy}
              onClick={() =>
                act(
                  () => submitWork(invoice.id, index),
                  "Submitting the work",
                )
              }
            >
              {busy ? "Waiting for wallet…" : "Submit work"}
            </button>
          </div>
        )}

      {isPaid && isClient && milestone.state === "Submitted" && (
        <div style={{ marginTop: 10 }}>
          {invoice.disputed ? (
            <p className="muted" style={{ margin: 0 }}>
              Approval is blocked while a dispute is open.
            </p>
          ) : (
            <>
              <div className="row">
                <button
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => approveMilestone(invoice.id, index),
                      "Approving",
                    )
                  }
                >
                  {busy ? "Waiting for wallet…" : "Approve and release"}
                </button>
              </div>
              <label
                htmlFor={`change-reason-${invoice.id}-${index}`}
                style={{ marginTop: 10 }}
              >
                What needs to change?
              </label>
              <input
                id={`change-reason-${invoice.id}-${index}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. the logo is the wrong colour"
                autoComplete="off"
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn btn-ghost btn-small"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    act(
                      () =>
                        requestChanges(invoice.id, index, reason.trim()),
                      "Asking for changes",
                    )
                  }
                >
                  Ask for changes
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {isPaid && isSeller && milestone.state === "Submitted" && (
        <div style={{ marginTop: 10 }}>
          {invoice.disputed ? (
            <p className="muted" style={{ margin: 0 }}>
              Claiming is blocked while a dispute is open.
            </p>
          ) : windowHasPassed(milestone) ? (
            <div className="row">
              <button
                className="btn btn-small"
                disabled={busy}
                onClick={() =>
                  act(
                    () => claimMilestone(invoice.id, index),
                    "Claiming",
                  )
                }
              >
                {busy ? "Waiting for wallet…" : "Claim this part"}
              </button>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              You can claim this on{" "}
              {claimableAt !== null ? formatDate(claimableAt) : ""} if the
              client stays silent.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function MilestoneChecklist({
  invoice,
  account,
  onChanged,
  showHeading = true,
}: {
  invoice: Invoice;
  /** Signed-in account, or null for the public (read-only) view. */
  account: string | null;
  /** Called after a successful action, so the parent reloads the invoice. */
  onChanged?: () => void | Promise<void>;
  /** Hide the section heading + intro (when the parent already labels the section). */
  showHeading?: boolean;
}) {
  const [milestones, setMilestones] = useState<Milestone[] | null>(null);
  const [splits, setSplits] = useState<SplitShare[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        getMilestones(invoice.id),
        getSplits(invoice.id),
      ]);
      setMilestones(m);
      setSplits(s);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Pre-v5 contract: the milestone methods do not exist yet, so
      // the view call fails with MethodNotFound. That just means a
      // plain invoice — render nothing instead of an error line on
      // every pay page until the v5 deploy + migrate lands.
      if (/methodnotfound|method[^"]*not found|does ?n'?t exist/i.test(msg)) {
        setMilestones([]);
        setSplits([]);
        return;
      }
      setLoadError(friendlyError(e));
    }
  }, [invoice.id]);

  useEffect(() => {
    load();
  }, [load]);

  function handleChanged(): Promise<void> {
    return load().then(() => {
      onChanged?.();
    });
  }

  if (milestones === null) {
    return loadError ? (
      <p className="muted">Could not load the milestones: {loadError}</p>
    ) : (
      <p className="muted">Loading milestones…</p>
    );
  }

  if (milestones.length === 0 && splits.length === 0) {
    return null;
  }

  const isSeller = account === invoice.seller;

  return (
    <div className="milestone-check">
      {showHeading && (
        <>
          <h3 style={{ margin: "0 0 4px" }}>Milestones</h3>
          <p className="sub">
            {invoice.status === "Paid"
              ? "The client funded the whole invoice up front. Each part below is released when its work is done."
              : "This invoice is split into parts. Each part is funded when the client pays, then released when its work is done."}
          </p>
        </>
      )}
      {milestones.map((m, i) => (
        <MilestoneRow
          key={i}
          invoice={invoice}
          milestone={m}
          index={i}
          account={account}
          splits={splits}
          onChanged={handleChanged}
        />
      ))}
      {milestones.length === 0 && splits.length > 0 && (
        <SplitBreakdown
          amountYocto={invoice.amount}
          splits={splits}
          seller={invoice.seller}
          label="When this invoice is released, it is shared:"
        />
      )}
      {invoice.status === "Paid" && !invoice.released && (
        <p className="muted" style={{ marginTop: 12 }}>
          {milestones.length > 0 && isSeller
            ? "Releasing the whole invoice (the button below) releases every part that is still waiting, at once. "
            : ""}
          {milestones.length > 0
            ? "A refund returns only the parts that have not been released yet."
            : "A refund returns the full amount, split the same way."}
        </p>
      )}
    </div>
  );
}
