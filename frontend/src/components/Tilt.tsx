import { useRef, type MouseEvent, type ReactNode } from "react";

/* Mouse-follow 3D tilt for a card: the card tips toward the
 * cursor (rotateX/rotateY from the pointer position, max 12
 * degrees) and its shadow shifts with it, so the flat card reads
 * as an object. Pure React + inline styles, no library. Touch
 * devices get no tilt (there is no cursor to follow); the
 * prefers-reduced-motion check keeps it off for people who
 * asked for less motion. */
const MAX_TILT = 12;

export default function Tilt({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    const rx = (-y * MAX_TILT).toFixed(2);
    const ry = (x * MAX_TILT).toFixed(2);
    el.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) scale3d(1.02, 1.02, 1)`;
    el.style.boxShadow = `${(-x * 12).toFixed(1)}px ${(-y * 12 + 10).toFixed(1)}px 24px rgba(28, 26, 23, 0.12)`;
  }

  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "";
    el.style.boxShadow = "";
  }

  return (
    <div
      ref={ref}
      className={className}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {children}
    </div>
  );
}
