import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scroll reveal, CSS-only motion: the element starts slightly lower
 * and transparent, and fades into place when it enters the viewport
 * (IntersectionObserver, no library, no heavy dependency). Once
 * visible it stays visible. Respects prefers-reduced-motion via CSS:
 * with reduced motion the element is shown immediately, no transition.
 */
export default function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  /** Stagger, in milliseconds, for siblings that reveal together. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

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
      { threshold: 0.1, rootMargin: "0px 0px -32px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal${visible ? " is-visible" : ""}${
        className ? ` ${className}` : ""
      }`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
