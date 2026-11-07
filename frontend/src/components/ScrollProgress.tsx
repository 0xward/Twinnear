import { useEffect, useRef } from "react";

/**
 * Thin scroll progress bar fixed to the top of the viewport. The fill
 * is a gradient across the logo palette (teal, pale blue, lavender).
 * The fill is a scaleX transform only — no layout work on scroll. The
 * scroll listener is passive and throttled with requestAnimationFrame.
 * Hidden under prefers-reduced-motion (CSS).
 */
export default function ScrollProgress() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let queued = false;
    const update = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
      el.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={ref} className="scroll-progress" aria-hidden="true" />;
}
