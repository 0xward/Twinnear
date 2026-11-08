/**
 * Split editor for NewInvoice (contract v5, NEAR only).
 *
 * The seller decides who each release is shared with: up to 3
 * recipients, percents adding up to exactly 100%. The percents are
 * shown as percents here and converted to basis points only when
 * sent to the contract. Every release is split the same way — one
 * milestone, or the whole invoice when there are no milestones.
 */
import { useMemo } from "react";
import { validateSplits } from "../lib/milestones";
import type { SplitShareInput } from "../lib/types";

export interface SplitDraft {
  account: string;
  /** Percent as typed, whole numbers (e.g. "90"). */
  percent: string;
}

export const EMPTY_SPLIT: SplitDraft = { account: "", percent: "" };

/** Convert drafts to contract inputs. Null when any percent is not a whole number. */
export function splitDraftsToInputs(
  rows: SplitDraft[],
): SplitShareInput[] | null {
  const inputs: SplitShareInput[] = [];
  for (const row of rows) {
    if (row.account.trim() === "" && row.percent.trim() === "") {
      continue;
    }
    if (!/^\d+$/.test(row.percent.trim())) return null;
    inputs.push({
      account: row.account.trim(),
      share_bps: Number(row.percent.trim()) * 100,
    });
  }
  return inputs;
}

/** True when every row is empty (no splits configured). */
export function splitDraftsAreEmpty(rows: SplitDraft[]): boolean {
  return rows.every(
    (r) => r.account.trim() === "" && r.percent.trim() === "",
  );
}

export default function SplitEditor({
  rows,
  onChange,
  releaseAmountsYocto,
}: {
  rows: SplitDraft[];
  onChange: (rows: SplitDraft[]) => void;
  /** Every amount a release can pay from (each milestone amount, or
   *  the full invoice amount when there are no milestones). Used for
   *  the 0.002 NEAR minimum-share check. */
  releaseAmountsYocto: string[];
}) {
  function setRow(i: number, patch: Partial<SplitDraft>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const percentSum = useMemo(() => {
    let sum = 0;
    let allParse = true;
    for (const row of rows) {
      if (row.percent.trim() === "") continue;
      if (!/^\d+$/.test(row.percent.trim())) {
        allParse = false;
        continue;
      }
      sum += Number(row.percent.trim());
    }
    return { sum, allParse };
  }, [rows]);

  const inputs = useMemo(() => splitDraftsToInputs(rows), [rows]);
  const validationError = useMemo(() => {
    if (inputs === null) {
      return "One split percent is not a whole number. Use a number like 90.";
    }
    return validateSplits(inputs, releaseAmountsYocto);
  }, [inputs, releaseAmountsYocto]);

  return (
    <div>
      <div className="label-row">
        <span className="label">Split each release</span>
        <span className="muted">
          {rows.length} recipient{rows.length === 1 ? "" : "s"} · max 3
        </span>
      </div>
      <div className="line-items">
        <div className="milestone-head" aria-hidden="true">
          <span>Recipient</span>
          <span>Percent (%)</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="milestone-row" key={i}>
            <input
              value={row.account}
              onChange={(e) => setRow(i, { account: e.target.value })}
              placeholder="teammate.testnet"
              aria-label={`Split ${i + 1} recipient account`}
              autoComplete="off"
            />
            <input
              value={row.percent}
              onChange={(e) => setRow(i, { percent: e.target.value })}
              placeholder="10"
              inputMode="numeric"
              aria-label={`Split ${i + 1} percent`}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() =>
                onChange(
                  rows.length > 1
                    ? rows.filter((_, j) => j !== i)
                    : [{ ...EMPTY_SPLIT }],
                )
              }
              disabled={rows.length === 1 && splitDraftsAreEmpty([row])}
              aria-label={`Remove split ${i + 1}`}
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
          onClick={() => onChange([...rows, { ...EMPTY_SPLIT }])}
          disabled={rows.length >= 3}
        >
          + Add recipient
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        {percentSum.allParse
          ? percentSum.sum === 100
            ? "Splits add up to 100%. Every release is shared this way."
            : `Splits add up to ${percentSum.sum}% so far. They must add up to exactly 100%.`
          : "Splits must add up to exactly 100%. One percent below is not a whole number."}
      </p>
      {validationError && (
        <div className="error" role="alert" style={{ marginTop: 8 }}>
          {validationError}
        </div>
      )}
      <p className="muted" style={{ marginTop: 8 }}>
        Leave this empty to keep the whole release for yourself. A split
        cannot be changed later, and every recipient must get at least
        0.002 NEAR from each release.
      </p>
    </div>
  );
}
