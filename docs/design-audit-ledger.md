# Design audit — Ledger page (2026-11-07)

Audit of the Ledger (`#/`, `Dashboard.tsx`) and the shared chrome
(masthead, nav, trust strip), triggered by the user's screenshots
(2026-11-07 21:12 and 21:16 WIB). The user circled: the four stat-card
NEAR logos (too big), the header tagline, the nav bar, the page title +
subtitle, and the trust strip. Verdict in one line: **the paper design
system is coherent, but the Ledger page is not assertive ("kurang
tegas")** — the biggest numbers on the page outrank the page title, the
strip reads as one ragged paragraph, and on a phone the nav hides tabs
mid-word.

Evidence: the user's two screenshots, the live Ledger text
(`twinnear.vercel.app/#`, fetched 2026-11-07), and the source
(`frontend/src/index.css`, `App.tsx`, `pages/Dashboard.tsx`,
`components/TrustStrip.tsx`, `components/CurrencyIcon.tsx`).
An agent cannot screenshot the real render; visual confirmation in a
browser is still the user's step.

## What was fixed in this pass (small, safe, paper-aligned)

1. **Stat-card currency marks — compact.** `.currency-icon` is `1em`,
   so beside a 28px stat value the NEAR mark rendered at 28px —
   bigger than the mark in the Recent-invoices table (~14px), which
   the user likes. `CurrencyIcon` now takes `size="sm"` (fixed 15px,
   `.currency-icon--sm`); the five stat-card values in `Dashboard.tsx`
   use it. No second logo component.
2. **Header tagline.** `.brand small` was sans, 12px, uppercase,
   letterspaced, soft grey — the same voice as every label on the
   page, so the slogan had no identity. It is now serif italic,
   14px, weight 500, ink colour, normal case: a bookplate motto,
   distinct from body and label text. Wording unchanged.
3. **Hierarchy inversion fixed.** Stat values (28px) were larger than
   the page H1 (26px), so the eye landed on four equal big numbers
   instead of the page title. Stat values are now 24px (mobile: 22px,
   unchanged) and the page-head H1 is 30px / weight 700. Order is now
   H1 30 > stat values 24 > card H2 22.
4. **Nav on mobile wraps instead of scrolling.** At ≤640px the nav was
   `flex-wrap: nowrap; overflow-x: auto` with a hidden scrollbar, so
   "Client portal" was cut mid-word ("Clie…") with no cue it could
   scroll. It now wraps like the desktop nav, pills stay whole
   (`white-space: nowrap` kept), and the active pill is semibold
   (600) so the current page reads as a destination, not just a hover.
5. **Trust strip grouping.** The two links were loose flex items that
   dangled one per line when the strip wrapped. They now travel as one
   `.trust-links` group pushed right on wide screens (wraps below as a
   unit on a phone), and the escrow figure (`0 [mark] in escrow now`)
   is `white-space: nowrap` so it never splits mid-figure.

## Findings (per area)

### 1. Stat cards — numbers dominate, labels whisper
- `.stat .label` is 11px uppercase letterspaced faint grey;
  `.stat .value` was 28px serif 700. The gap is correct in principle,
  but the four cards' sub-labels are inconsistent: three are short
  fragments ("escrow released to you · ≈ $0.19"), one is a full
  sentence ("1Click payments confirmed by the seller, not checked
  on-chain") that wraps to three lines on a phone, so the cards have
  uneven heights. Fixed in part by (1) and (3); the sentence is a
  content decision (see P2 below).

### 2. Header tagline — no voice of its own
- See fix (2). Root cause: the tagline reused the label style
  (sans/uppercase/letterspaced/soft), so it read as another UI label
  rather than the product's motto. The logo SVG already carries the
  "TWINNEAR" wordmark, so the tagline is the only header text — it
  has to carry the personality.

### 3. Nav — nine equal pills, current page unclear, mobile cutoff
- Nine items at 14px, all the same weight and the same soft-green
  fill for hover *and* active, so the current page barely registers.
  On a phone the hidden-scrollbar scroll cut tabs mid-word. Fixed in
  part by (4). Nine top-level items is a lot for a phone; see P2.

### 4. Page title + subtitle — flat
- "The ledger" (26px, weight 600) + a 13.5px muted paragraph. The
  title was smaller than the stat numbers below it, and the subtitle
  runs the intro and the "New here?" link into one plain paragraph —
  nothing separates "this is the page" from "this is help text".
  Fixed in part by (3) (H1 30px/700). The subtitle structure is a
  P1 proposal below.

### 5. Trust strip — one ragged paragraph
- Seven flex items (stamp, contract, count, escrow, marketing claim,
  two links) share one 13px soft-grey voice with 6px/16px gaps, so on
  a phone they reflow as a ragged block and the eye cannot tell facts
  ("4 invoices on chain") from claims ("No fees. No signup. No
  custody.") from links. Fixed in part by (5). A real restructure is
  P1 below.

### 6. General — flat section rhythm
- Ledger sections (trust strip → stat grid → "Fiat amounts…" note →
  Clients → Recent invoices → footer) are separated only by uniform
  18px gaps. Card H2s (22px) sit close to their subtitles; the
  "New invoice" CTA lives at the bottom of Recent invoices instead of
  near the top. The page reads as one long list rather than a
  ledger with entries. See P1/P2.

## Proposals (not implemented — user's choice)

### P1 — Trust strip, real restructure
Split the strip into two visual rows: row 1 = live facts only
(TESTNET stamp, contract + schema, invoice count, escrow figure),
row 2 = the claim + the two links. Or a small grid with the escrow
figure emphasised (serif bold). Needs a layout decision, not just CSS.

### P1 — Page-head structure
Give the subtitle a shape: keep the intro sentence, move "New here?
Read what Twinnear is." onto its own line or into a quiet link
under the title; add a hairline rule under the page-head so the title
block reads as a masthead for the page, not as the first paragraph.

### P2 — Stat-card sub-labels, one voice
Rewrite the four sub-labels as parallel fragments of similar length
(e.g. "escrow released to you", "1Click payments, seller-confirmed",
"held for open invoices", "3 unpaid invoices"), all with the fiat
estimate in the same position. Content call, not code.

### P2 — Nav, fewer top-level items on mobile
Nine pills is crowded on a phone even wrapped. Options: move About /
Docs / FAQ into the footer only, or collapse secondary pages under a
"More" item on small screens. Navigation-structure call.

### P2 — Section rhythm on the Ledger
Add a hairline rule + slightly larger top margin before the Clients
and Recent-invoices cards, and/or move the "New invoice" CTA next to
the page title so the primary action is visible without scrolling.

### P3 — A more assertive paper voice (taste)
- Card borders 1px → 1.5px ink-strong, or a slightly deeper shadow,
  so cards sit more firmly on the paper.
- A display serif for H1 (Georgia is already the serif stack; a
  webfont would change load time — needs a decision).
- The "No fees. No signup. No custody." claim as its own eyebrow
  line under the strip instead of inline with the facts.

## Verification (agent level only)
- `npm run build` green; push via the manifest flow; live entry
  chunk + Ledger text re-checked after deploy. Visual render
  (alignment of the 15px marks, italic tagline, wrapped nav, grouped
  strip) must be confirmed by the user in a real browser.
