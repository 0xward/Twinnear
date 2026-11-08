import shareSvg from "../assets/wm-share.svg?raw";
import docCheckSvg from "../assets/wm-doc-check.svg?raw";
import cashSvg from "../assets/wm-cash.svg?raw";
import handshakeSvg from "../assets/wm-handshake.svg?raw";
import gasSvg from "../assets/wm-gas.svg?raw";
import peopleSvg from "../assets/wm-people.svg?raw";
import layersSvg from "../assets/wm-layers.svg?raw";
import calendarSvg from "../assets/wm-calendar.svg?raw";
import shieldSvg from "../assets/wm-shield.svg?raw";

/* Faint watermark icon for a landing card: one of the nine icons the
 * user supplied as JPGs, traced to monochrome SVG (fill="currentColor")
 * and rendered inline so it inherits the wash-tinted colour from the
 * span. The SVG files live in src/assets/wm-*.svg; they are imported
 * ?raw (text) rather than as <img> because an <img> cannot inherit
 * currentColor for tinting.
 *
 * Treatment (deep-research recommendation, applied 2026-11-08):
 * 120px, bottom-right corner, bled 20px off the card edge and cropped
 * by the card's overflow:hidden, opacity 10% (8% on the cream wash),
 * fill = a darkened version of the card's own wash so the colours
 * differ per card but stay in one vibe. Rotation 0. Decorative only:
 * aria-hidden, pointer-events none, text rides above at z-index 1
 * (see .wm in index.css). */

export type WatermarkIcon =
  | "share"
  | "doc-check"
  | "cash"
  | "handshake"
  | "gas"
  | "people"
  | "layers"
  | "calendar"
  | "shield";

const ICONS: Record<WatermarkIcon, string> = {
  share: shareSvg,
  "doc-check": docCheckSvg,
  cash: cashSvg,
  handshake: handshakeSvg,
  gas: gasSvg,
  people: peopleSvg,
  layers: layersSvg,
  calendar: calendarSvg,
  shield: shieldSvg,
};

/* Wash -> watermark fill + opacity. The fill is a darkened version of
 * the card's own wash (blue wash -> teal, lavender -> slate,
 * teal/cream/green -> deep green accent), so each card's mark reads as
 * part of its card, not as a foreign grey stamp. */
const TINT_STYLE: Record<string, { fill: string; opacity: number }> = {
  "tint-blue": { fill: "var(--logo-teal)", opacity: 0.1 },
  "tint-lavender": { fill: "var(--logo-slate)", opacity: 0.1 },
  "tint-teal": { fill: "var(--accent)", opacity: 0.1 },
  "tint-cream": { fill: "var(--accent)", opacity: 0.08 },
  "tint-green": { fill: "var(--accent)", opacity: 0.1 },
};

export default function CardWatermark({
  tint,
  icon,
}: {
  tint: string;
  icon: WatermarkIcon;
}) {
  const style = TINT_STYLE[tint] ?? { fill: "var(--accent)", opacity: 0.1 };
  return (
    <span
      className="wm"
      aria-hidden="true"
      style={{ color: style.fill, opacity: style.opacity }}
      dangerouslySetInnerHTML={{ __html: ICONS[icon] }}
    />
  );
}
