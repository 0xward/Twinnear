/**
 * Funded milestones + programmable splits (contract schema v5).
 *
 * Pure helpers shared by the NewInvoice builder, the milestone
 * checklist, and the NEP-413 relayer message. All money math is
 * BigInt yoctoNEAR, mirroring contract/src/lib.rs exactly:
 * - a split share is floor(amount * bps / 10000), and any leftover
 *   dust goes to the FIRST recipient (see `split_release`);
 * - every share of every release must be at least 0.002 NEAR
 *   (MIN_SPLIT_SHARE_YOCTO);
 * - the 14-day inspection window runs from `submitted_at` and the
 *   seller may claim only after it passes.
 *
 * UI language: percentages, never basis points; plain words, never
 * jargon. 0 em-dash in user-facing strings.
 */
import type {
  Milestone,
  MilestoneInput,
  MilestoneState,
  SplitShare,
  SplitShareInput,
} from "./types";
import { isValidAccountId } from "./near";

export const MAX_MILESTONES = 5;
export const MAX_SPLITS = 3;
export const MAX_MILESTONE_DESC_BYTES = 200;
export const INSPECTION_DAYS = 14;
/** Minimum one split recipient gets from any single release. */
export const MIN_SPLIT_SHARE_YOCTO = 2_000_000_000_000_000_000_000n; // 0.002 NEAR

const DAY_NS = 86_400_000_000_000n;

/** Plain-language label for a milestone state. */
export function milestoneStateLabel(state: MilestoneState): string {
  switch (state) {
    case "Pending":
      return "Waiting for work";
    case "Submitted":
      return "Sent for review";
    case "ChangesRequested":
      return "Changes requested";
    case "Released":
      return "Released";
  }
}

/** Stamp class for a milestone state (reuses the invoice stamps). */
export function milestoneStampClass(state: MilestoneState): string {
  switch (state) {
    case "Pending":
      return "stamp stamp-pending";
    case "Submitted":
      return "stamp stamp-testnet";
    case "ChangesRequested":
      return "stamp stamp-refunded";
    case "Released":
      return "stamp stamp-paid";
  }
}

/** Nanosecond timestamp when the 14-day window ends, or null. */
export function claimableAtNs(submittedAtNs: number | null): number | null {
  if (submittedAtNs === null) return null;
  return Number(BigInt(submittedAtNs) + BigInt(INSPECTION_DAYS) * DAY_NS);
}

/** Whole days left in the inspection window (0 when it has passed). */
export function windowDaysLeft(submittedAtNs: number | null): number {
  const at = claimableAtNs(submittedAtNs);
  if (at === null) return 0;
  const leftMs = at / 1_000_000 - Date.now();
  return leftMs <= 0 ? 0 : Math.ceil(leftMs / 86_400_000);
}

/** True when a Submitted milestone is past its 14-day window. */
export function windowHasPassed(m: Milestone): boolean {
  return m.state === "Submitted" && windowDaysLeft(m.submitted_at) === 0;
}

export interface ComputedShare {
  account: string;
  shareBps: number;
  /** Share in percent (bps / 100), for display. */
  percent: number;
  /** YoctoNEAR this recipient gets from this release. */
  amountYocto: string;
}

/**
 * How one release amount is shared, exactly as the contract computes
 * it (`split_release`): floor(amount * bps / 10000) per recipient,
 * leftover dust to the first recipient. No splits = 100% to the
 * seller.
 */
export function computeSplitShares(
  amountYocto: string,
  splits: SplitShare[],
  seller: string,
): ComputedShare[] {
  const amount = BigInt(amountYocto);
  if (splits.length === 0) {
    return [
      { account: seller, shareBps: 10000, percent: 100, amountYocto },
    ];
  }
  const shares = splits.map((s) => ({
    account: s.account,
    shareBps: s.share_bps,
    percent: s.share_bps / 100,
    amountYocto: ((amount * BigInt(s.share_bps)) / 10_000n).toString(),
  }));
  const distributed = shares.reduce(
    (sum, s) => sum + BigInt(s.amountYocto),
    0n,
  );
  const dust = amount - distributed;
  if (dust > 0n && shares.length > 0) {
    shares[0].amountYocto = (BigInt(shares[0].amountYocto) + dust).toString();
  }
  return shares;
}

/**
 * Compact JSON of the milestones array, in the exact shape the
 * contract serializes with serde_json (`{"description":...,"amount":"..."}`,
 * amounts as strings, declaration order). This string is part of the
 * signed NEP-413 message — any difference (spacing, key order,
 * number instead of string) breaks the on-chain signature check.
 */
export function milestonesJson(milestones: MilestoneInput[]): string {
  return JSON.stringify(
    milestones.map((m) => ({ description: m.description, amount: m.amount })),
  );
}

/** Same, for the splits array (`{"account":...,"share_bps":...}`). */
export function splitsJson(splits: SplitShareInput[]): string {
  return JSON.stringify(
    splits.map((s) => ({ account: s.account, share_bps: s.share_bps })),
  );
}

/** Validate milestone rows against the invoice total. Null = valid. */
export function validateMilestones(
  milestones: MilestoneInput[],
  totalYocto: string | null,
): string | null {
  if (milestones.length === 0) return null;
  if (milestones.length > MAX_MILESTONES) {
    return `At most ${MAX_MILESTONES} milestones per invoice.`;
  }
  let total = 0n;
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    if (m.description.trim() === "") {
      return `Milestone ${i + 1} needs a short description of the work.`;
    }
    if (
      new TextEncoder().encode(m.description.trim()).length >
      MAX_MILESTONE_DESC_BYTES
    ) {
      return `Milestone ${i + 1} description is too long (at most 200 bytes).`;
    }
    let amount: bigint;
    try {
      amount = BigInt(m.amount);
    } catch {
      return `Milestone ${i + 1} amount is not a valid number.`;
    }
    if (amount <= 0n) {
      return `Milestone ${i + 1} amount must be more than zero.`;
    }
    total += amount;
  }
  if (totalYocto === null) {
    return "Set the invoice amount first, so the milestones can add up to it.";
  }
  if (total !== BigInt(totalYocto)) {
    return "Milestone amounts must add up to exactly the invoice total. Adjust one amount to close the gap.";
  }
  return null;
}

/**
 * Validate split rows. `releaseAmountsYocto` is every amount a
 * release can pay from: each milestone amount when milestones exist,
 * otherwise the full invoice amount. Null = valid.
 */
export function validateSplits(
  splits: SplitShareInput[],
  releaseAmountsYocto: string[],
): string | null {
  if (splits.length === 0) return null;
  if (splits.length > MAX_SPLITS) {
    return `At most ${MAX_SPLITS} split recipients per invoice.`;
  }
  const seen = new Set<string>();
  let totalBps = 0;
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const account = s.account.trim();
    if (account === "") {
      return `Split ${i + 1} needs an account to send to.`;
    }
    if (!isValidAccountId(account)) {
      return `"${account}" is not a valid NEAR account name.`;
    }
    if (seen.has(account)) {
      return `Split ${i + 1} repeats ${account}. Each recipient can only appear once.`;
    }
    seen.add(account);
    if (!Number.isInteger(s.share_bps) || s.share_bps <= 0) {
      return `Split ${i + 1} needs a percent above 0.`;
    }
    totalBps += s.share_bps;
  }
  if (totalBps !== 10_000) {
    return "Split percents must add up to exactly 100%.";
  }
  for (const releaseAmount of releaseAmountsYocto) {
    for (const s of splits) {
      const share =
        (BigInt(releaseAmount) * BigInt(s.share_bps)) / 10_000n;
      if (share < MIN_SPLIT_SHARE_YOCTO) {
        return (
          `${s.account.trim()} would get less than 0.002 NEAR from a release. ` +
          "Raise that milestone amount, or give this recipient a bigger percent."
        );
      }
    }
  }
  return null;
}
