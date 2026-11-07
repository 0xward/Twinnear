import { formatDate } from "../lib/near";
import type { Invoice } from "../lib/types";

/**
 * Status timeline for one invoice, derived from the timestamps the
 * contract stores: created → paid → released / refunded, plus the due
 * date, dispute state, and cancellation. No extra on-chain data needed.
 */
export default function InvoiceTimeline({ invoice }: { invoice: Invoice }) {
  const paid = invoice.status === "Paid" || invoice.status === "Refunded";
  const released = invoice.status === "Paid" && invoice.released;
  const refunded = invoice.status === "Refunded";
  const cancelled = invoice.status === "Cancelled";
  const external = invoice.status === "Paid" && invoice.external_ref !== null;
  const overdue =
    invoice.status === "Pending" &&
    invoice.due_date !== null &&
    Date.now() * 1_000_000 >= invoice.due_date;

  const steps: {
    label: string;
    date: number | null;
    done: boolean;
    note?: string;
  }[] = [
    {
      label: "Invoice created",
      date: invoice.created_at,
      done: true,
    },
    {
      label: invoice.due_date
        ? overdue
          ? "Overdue"
          : "Due date"
        : "No due date set",
      date: invoice.due_date,
      done: paid,
      note: paid
        ? undefined
        : invoice.due_date
          ? overdue
            ? "Past due and still unpaid."
            : "The client should pay before this date."
          : "No deadline was set for this invoice.",
    },
    {
      label: external
        ? "Paid externally (unverified)"
        : paid
          ? "Paid, held in escrow"
          : "Paid",
      date: invoice.paid_at,
      done: paid,
      note: paid
        ? external
          ? "Settled off-chain; the seller attested receipt (not verified on-chain)."
          : undefined
        : "Waiting for the client to pay.",
    },
    {
      label: invoice.disputed
        ? "Disputed by client"
        : cancelled
          ? "Cancelled by seller"
          : refunded
            ? "Refunded to client"
            : "Released to seller",
      // The contract stores no released/refunded timestamp, so no date
      // is shown here — only the state.
      date: null,
      done: refunded || released || cancelled,
      note: cancelled
        ? "Cancelled while pending. No funds moved."
        : invoice.disputed
          ? `Dispute open${invoice.dispute_reason ? `: “${invoice.dispute_reason}”` : ""}. Release is blocked until it is withdrawn or the seller refunds.`
          : refunded
            ? "Funds returned to the client."
            : released
              ? "Funds released to the seller."
              : "The seller releases the escrowed funds, or refunds the client.",
    },
  ];

  return (
    <ol className="timeline">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={s.done ? "done" : i === steps.findIndex((x) => !x.done) ? "next" : ""}
        >
          <span className="dot" aria-hidden="true" />
          <span className="tl-label">{s.label}</span>
          {s.date ? (
            <span className="tl-date">{formatDate(s.date)}</span>
          ) : s.note ? (
            <span className="tl-date">{s.note}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
