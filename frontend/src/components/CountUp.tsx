import { useEffect, useRef, useState } from "react";

/**
 * Count-up number: animates from its current display to `value` with
 * requestAnimationFrame and a cubic ease-out (~1.2 s), once it scrolls
 * into view (IntersectionObserver). The final frame renders exactly
 * `value.toFixed(decimals)`, so the number shown is always the true
 * value, never an approximation. If the target changes later (data
 * reloads), it animates from the current display to the new value
 * instead of snapping. Respects prefers-reduced-motion: shows the
 * final value at once. Text-only animation — no layout shift.
 */
export default function CountUp({
  value,
  decimals = 0,
  duration = 1200,
}: {
  /** Target number. Must already be the display value (e.g. parseFloat
   * of a formatted NEAR amount), not the raw smallest unit. */
  value: number;
  /** Fractional digits to show (match the formatted value). */
  decimals?: number;
  /** Animation length in milliseconds. */
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    if (!visible) return;
    let raf = 0;
    const from = displayRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const current = from + (value - from) * eased;
      displayRef.current = current;
      setDisplay(current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, decimals, visible, duration]);

  return <span ref={ref}>{display.toFixed(decimals)}</span>;
}

/** Fractional digits of a formatted amount string, e.g. "1.0301" -> 4. */
export function countDecimals(formatted: string): number {
  return (formatted.split(".")[1] ?? "").length;
}
