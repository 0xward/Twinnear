/**
 * Recurring invoices / retainers — frontend-only, localStorage.
 * No cron, no background job: templates live in the browser, and the
 * seller presses "Generate due invoices" to create whatever is due.
 * Each due invoice is one on-chain transaction (one wallet
 * confirmation per invoice) — the page says so.
 */
import type { Currency, LineItem } from "./types";

export const RECURRING_KEY = "twinnear.recurring.v1";

export type Frequency = "weekly" | "monthly" | "quarterly";

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
};

export interface RecurringTemplate {
  id: string;
  name: string;
  client: string;
  currency: Currency;
  items: LineItem[];
  taxRateBps: number;
  /** Total in the currency's smallest unit (subtotal + tax). */
  totalSmallestUnit: string;
  frequency: Frequency;
  /** Next due date, ISO date "YYYY-MM-DD" (local). */
  nextDue: string;
  active: boolean;
  /** ISO timestamp of the last generation, or null. */
  lastGeneratedAt: string | null;
  /** Invoice ids created from this template, newest last. */
  generatedIds: number[];
  createdAt: string;
}

export function loadTemplates(): RecurringTemplate[] {
  try {
    const raw = localStorage.getItem(RECURRING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecurringTemplate[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) => t && typeof t.id === "string" && typeof t.client === "string",
    );
  } catch {
    return [];
  }
}

export function saveTemplates(templates: RecurringTemplate[]): void {
  try {
    localStorage.setItem(RECURRING_KEY, JSON.stringify(templates));
  } catch {
    // Storage full / private mode — the page shows the error on save.
    throw new Error(
      "Could not save the retainer (browser storage unavailable).",
    );
  }
}

export function newTemplateId(): string {
  return `rt_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** "2026-11-07" for today (local time). */
export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** True when the template's next due date is today or earlier. */
export function isDue(t: RecurringTemplate, today: string = todayIso()): boolean {
  return t.active && t.nextDue <= today;
}

/** Advance a due date by one frequency step (calendar months). */
export function advanceDueDate(isoDate: string, freq: Frequency): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (freq === "weekly") {
    date.setDate(date.getDate() + 7);
  } else if (freq === "monthly") {
    date.setMonth(date.getMonth() + 1);
  } else {
    date.setMonth(date.getMonth() + 3);
  }
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Human date for a "YYYY-MM-DD" value. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
