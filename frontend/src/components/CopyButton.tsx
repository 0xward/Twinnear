import { useState } from "react";

/** Button that copies text and briefly confirms it did. */
export default function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied ✓",
  className = "btn btn-ghost",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (old browser / non-secure context):
      // fall back to a selectable prompt-free textarea trick.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className={className} onClick={handleClick}>
      {copied ? copiedLabel : label}
    </button>
  );
}
