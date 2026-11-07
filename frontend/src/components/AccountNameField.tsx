import { useEffect, useRef, useState } from "react";
import {
  accountExists,
  isAccountForNetwork,
  isValidAccountId,
} from "../lib/near";

/**
 * Account-name input with a live on-chain check.
 *
 * Visual states (icon only — the field never blocks submit; the
 * form still does its own check on submit, exactly as before):
 * - empty / still typing / checking → neutral, no icon.
 * - account found on-chain → green ✓ inside the field, green border.
 * - bad format or account not found → red ✗ inside the field, red
 *   border, plus a one-line hint saying why.
 *
 * The RPC check is debounced ~500ms and only runs for well-formed
 * `.testnet` names, so typing does not flood the RPC. A network
 * error leaves the field neutral: a failed check is not proof the
 * account is missing (accountExists rethrows network errors).
 */

export type AccountCheck = "idle" | "checking" | "ok" | "bad";

export function useAccountCheck(
  value: string,
  enabled = true,
): { status: AccountCheck; reason: "format" | "missing" | null } {
  const [status, setStatus] = useState<AccountCheck>("idle");
  const [reason, setReason] = useState<"format" | "missing" | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const name = value.trim();
    if (!enabled || name === "") {
      setStatus("idle");
      setReason(null);
      return;
    }
    // Neutral while the user is still typing; resolve ~500ms after
    // the last keystroke so half-typed names never flash ✓/✗.
    setStatus("checking");
    setReason(null);
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      if (!isValidAccountId(name) || !isAccountForNetwork(name)) {
        if (seq.current !== mySeq) return;
        setStatus("bad");
        setReason("format");
        return;
      }
      try {
        const exists = await accountExists(name);
        if (seq.current !== mySeq) return;
        setStatus(exists ? "ok" : "bad");
        setReason(exists ? null : "missing");
      } catch {
        // Network error — stay neutral, not "bad".
        if (seq.current !== mySeq) return;
        setStatus("idle");
        setReason(null);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [value, enabled]);

  return { status, reason };
}

interface AccountNameFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Optional datalist suggestions (e.g. clients already invoiced). */
  suggestions?: string[];
}

export default function AccountNameField({
  id,
  label,
  value,
  onChange,
  placeholder,
  suggestions,
}: AccountNameFieldProps) {
  const { status, reason } = useAccountCheck(value);
  const listId = suggestions ? `${id}-suggestions` : undefined;
  const hint =
    status === "ok"
      ? "Account found on testnet."
      : status === "bad" && reason === "format"
        ? "Use a valid .testnet account name."
        : status === "bad"
          ? "Account not found on testnet — check the spelling."
          : null;

  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <div className="field-wrap">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          list={listId}
          aria-invalid={status === "bad"}
          className={
            status === "ok" ? "field-ok" : status === "bad" ? "field-bad" : undefined
          }
        />
        {status === "ok" && (
          <span className="field-mark ok" aria-hidden="true">
            ✓
          </span>
        )}
        {status === "bad" && (
          <span className="field-mark bad" aria-hidden="true">
            ✗
          </span>
        )}
      </div>
      {hint && (
        <p className={`field-hint ${status === "ok" ? "ok" : "bad"}`} aria-live="polite">
          {hint}
        </p>
      )}
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
