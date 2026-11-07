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
6. **Reference direction — clearer card borders, bolder card titles.**
   From the user's three reference screenshots (see "Reference
   direction" below): `.card` and `.stat` borders now use
   `var(--line-strong)` (#c9c0ab) instead of the pale `var(--line)`
   (#e3ddd0), so cards sit firmly on the paper like the references'
   thin dark-bordered cards; card H2s are now weight 700, matching
   the references' bold black titles. No hue or layout changed.

## Reference direction — what the user likes (2026-11-07)

The user shared three reference screenshots and said: "aku suka yg
begini, ada sedikit warna tapi ga bikin kaya terlalu ramai bgt warna,
ini pas dan estetik" — a little colour, not too busy, just right and
aesthetic. The common pattern across all three:

- **Warm cream/paper background**, never stark white.
- **Thin dark borders** that define every card crisply.
- **ONE restrained accent** (or one muted pastel family): yellow
  header + orange CTA (book app), coral red for Search/Apply (job
  board), soft pastels one per card (library). Colour is used boldly
  in very few places.
- **Bold black titles** — the hierarchy is unmistakable.
- **Small coloured pills, used sparingly** — two per job card
  (Full-time green, Mid Level red), one dot per library category.
- **Clean cards, generous whitespace** — colour never crowds.

### What each reference teaches Twinnear

- **Book/audiobook app** (warm cream, yellow header bar, orange
  accent button, thin dark card borders, icon sidebar): the lesson
  is *one warm accent, used boldly in a single band*. Twinnear's
  equivalent is its deep-green accent — already used for buttons and
  the active nav pill. Adopted: the idea of letting the accent own
  one clear element instead of tinting everything. Not adopted: a
  coloured header bar — Twinnear's masthead is the paper-cut logo on
  paper, and a yellow/green bar would fight the logo.
- **Job board** (cream, coral-red accent, small coloured pills,
  bold black headline "Find your Dream Job", bordered cards): the
  lesson is *pills + headline*. Twinnear already has small coloured
  status stamps (PENDING amber, PAID green, REFUNDED red) — the same
  device as the job board's Full-time/Mid Level pills, and it should
  stay. Adopted: bolder titles (card H2 → 700) and crisper card
  borders. Not adopted: coral red — Twinnear's accent is deep green
  by identity; swapping the accent hue is a branding decision, not a
  polish fix (see P2).
- **Library app** (soft pastel cards, big bold serif title, coloured
  dots in the sidebar, filter pills): the lesson is *serif can be
  bold and warm at the same time* — its "Computer Science" title is a
  large bold serif, exactly Twinnear's voice, and it proves the paper
  + serif direction can be assertive without going sans. Adopted: the
  H1 30px/700 treatment. Not adopted: a different pastel fill per
  card — Twinnear's ledger is one bookkeeper's book, not a shelf of
  books; per-card pastels would make it busy, the exact thing the
  user said to avoid.

### What this means for Twinnear's paper design
Twinnear is already close to the references on the fundamentals:
paper background, serif, one accent, small coloured pills. The gap
was never the palette — it was *definition*: borders too pale to
hold the cards, titles too light to anchor the page, and the accent
too shy to lead. The fixes in this pass (stronger card borders,
bolder titles, H1 30px/700, wrapping nav, grouped trust strip) move
Twinnear toward the references without adding a single new colour.
What is deliberately NOT done: no new accent hue, no per-card pastel
fills, no coloured header bar, no extra pills — the restraint *is*
the aesthetic the user praised.

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

### P2 — Accent: livelier green, or a warm second accent?
The references use their accent boldly (yellow bar, coral buttons).
Twinnear's deep green (#1f4d3a) reads almost black, so it leads
quietly. Options, all branding calls: a slightly brighter/livelier
green as the single accent; or keep green for actions and add one
warm amber reserved for the "New invoice" CTA only. Either keeps the
one-accent restraint; neither should be done casually.

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
- Warm the card fill a touch (pure #fff → #fffaf0) so cards read as
  cream paper like the references, not stark white. Barely visible
  alone; combined with the stronger border it completes the warm
  feel. Needs a visual check — a touch too far reads as dirty.

## Verification (agent level only)
- `npm run build` green; push via the manifest flow; live entry
  chunk + Ledger text re-checked after deploy. Visual render
  (alignment of the 15px marks, italic tagline, wrapped nav, grouped
  strip) must be confirmed by the user in a real browser.
