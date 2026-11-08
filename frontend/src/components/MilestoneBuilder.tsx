/**
 * Milestone builder for NewInvoice (contract v5, NEAR only).
 *
 * The seller splits the invoice total into up to 5 funded parts.
 * Each part has a short description of the work and an amount in
 * NEAR. The parts must add up to exactly the invoice total — the
 * running sum below the rows shows the gap in plain words, and the
 * contract enforces the same sum on-chain.
 */
import { useMemo } from "react";
import { formatNear, parseNearAmount } from "../lib/near";
import { validateMilestones } from "../lib/milestones";
import type { MilestoneInput } from "../lib/types";

export interface MilestoneDraft {
  description: string;
  /** Amount in NEAR, as typed (display units, e.g. "0.5"). */
  amount: string;
}

export const EMPTY_MILESTONE: MilestoneDraft = { description: "", amount: "" };

/**
 * Convert drafts to contract inputs. Returns null when any amount
 * is not a plain decimal number (the caller then reports the row).
 */
export function draftsToInputs(
  rows: MilestoneDraft[],
): MilestoneInput[] | null {
  const inputs: MilestoneInput[] = [];
  for (const row of rows) {
    if (row.description.trim() === "" && row.amount.trim() === "") {
      continue;
    }
    const yocto = parseNearAmount(row.amount.trim());
    if (yocto === null) return null;
    inputs.push({ description: row.description.trim(), amount: yocto });
  }
  return inputs;
}

/** True when every row is empty (no milestones configured). */
export function draftsAreEmpty(rows: MilestoneDraft[]): boolean {
  return rows.every(
    (r) => r.description.trim() === "" && r.amount.trim() === "",
  );
}

export default function MilestoneBuilder({
  rows,
  onChange,
  totalYocto,
}: {
  rows: MilestoneDraft[];
  onChange: (rows: MilestoneDraft[]) => void;
  /** Invoice total in yoctoNEAR, or null while the total is unknown. */
  totalYocto: string | null;
}) {
  function setRow(i: number, patch: Partial<MilestoneDraft>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const sumYocto = useMemo(() => {
    let sum = 0n;
    let allParse = true;
    for (const row of rows) {
      if (row.amount.trim() === "") continue;
      const parsed = parseNearAmount(row.amount.trim());
      if (parsed === null) {
        allParse = false;
        continue;
      }
      sum += BigInt(parsed);
    }
    return { sum, allParse };
  }, [rows]);

  const inputs = useMemo(() => draftsToInputs(rows), [rows]);
  const validationError = useMemo(() => {
    if (inputs === null) {
      return "One milestone amount is not a plain number. Use a number like 0.5.";
    }
    return validateMilestones(inputs, totalYocto);
  }, [inputs, totalYocto]);

  const total = totalYocto === null ? null : BigInt(totalYocto);
  const gap =
    total === null || !sumYocto.allParse ? null : total - sumYocto.sum;

  return (
    <div>
      <div className="label-row">
        <span className="label">Milestones</span>
        <span className="muted">
          {rows.length} part{rows.length === 1 ? "" : "s"} · max 5
        </span>
      </div>
      <div className="line-items">
        <div className="milestone-head" aria-hidden="true">
          <span>What the work is</span>
          <span>Amount (NEAR)</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="milestone-row" key={i}>
            <input
              value={row.description}
              onChange={(e) => setRow(i, { description: e.target.value })}
              placeholder="First draft, homepage design"
              aria-label={`Milestone ${i + 1} description`}
              autoComplete="off"
            />
            <input
              value={row.amount}
              onChange={(e) => setRow(i, { amount: e.target.value })}
              placeholder="0.5"
              inputMode="decimal"
              aria-label={`Milestone ${i + 1} amount in NEAR`}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() =>
                onChange(
                  rows.length > 1
                    ? rows.filter((_, j) => j !== i)
                    : [{ ...EMPTY_MILESTONE }],
                )
              }
              disabled={rows.length === 1 && draftsAreEmpty([row])}
              aria-label={`Remove milestone ${i + 1}`}
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
          onClick={() => onChange([...rows, { ...EMPTY_MILESTONE }])}
          disabled={rows.length >= 5}
        >
          + Add milestone
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        {total === null
          ? "Milestones add up to the invoice total. Set the amount above first."
          : sumYocto.allParse
            ? gap === 0n
              ? `Milestones add up to ${formatNear(totalYocto as string)} NEAR, the full invoice total.`
              : gap !== null && gap > 0n
                ? `Milestones add up to ${formatNear(sumYocto.sum.toString())} NEAR so far, ${formatNear(gap.toString())} NEAR short of the ${formatNear(totalYocto as string)} NEAR total.`
                : `Milestones add up to ${formatNear(sumYocto.sum.toString())} NEAR, ${formatNear((-gap!).toString())} NEAR over the ${formatNear(totalYocto as string)} NEAR total.`
            : "Milestones add up to the invoice total. One amount below is not a plain number."}
      </p>
      {validationError && (
        <div className="error" role="alert" style={{ marginTop: 8 }}>
          {validationError}
        </div>
      )}
      <p className="muted" style={{ marginTop: 8 }}>
        The client funds the whole invoice up front. Each part is
        released when its work is done: you send the work, the client
        approves it, or the client stays silent for 14 days and you
        claim it.
      </p>
    </div>
  );
}
