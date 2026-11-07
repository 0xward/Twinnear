# Scroll animation research — Twinnear (7 Nov 2026)

Short, directed research: which scroll-animation patterns make a
product site feel alive without being gaudy, with no new library.
Sources: modern-web-design skill (2025–2026 trends), GSAP scroll
examples (motionkit.io), premium-animation-toolkit skill, and the
high-fidelity-web techniques reference (Stripe / Linear / Vercel /
Apple patterns). All of it is implemented here with CSS + the
existing IntersectionObserver `Reveal` component, not with a library.

## Patterns chosen (and where each is used)

1. **Staggered grid reveal** — siblings fade in one after another
   (70 ms apart, opacity only). Grids must stagger on opacity alone:
   translating siblings makes rows uneven mid-animation and reads as
   a layout bug. Used on: landing pay pills, How-it-works steps,
   feature cards, Proven cards, Ledger stat cards.
2. **Count-up numbers** — numbers animate 0 → true value on scroll
   into view, `requestAnimationFrame` + cubic ease-out, ~1.2 s, fires
   when the element enters view; the final frame renders exactly the
   true value, never an approximation. Used on: Ledger stat values
   (Received, External, In escrow, Outstanding, USDC, Refunded,
   Cancelled counts) and TrustStrip (invoice count, escrow total).
   If the target changes later (data reload), it animates from the
   current display to the new value instead of snapping.
3. **Scroll progress bar** — a 3 px bar fixed to the top of the
   viewport, fill driven by scroll position (scaleX transform only,
   passive listener + rAF throttle). The fill is a gradient across
   the logo palette (teal → pale blue → lavender). Global, on every
   page. Hidden under `prefers-reduced-motion`.
4. **Route-change entrance** — the page content fades and rises 10 px
   (0.4 s) on every navigation (keyed wrapper in App). Page cards
   already rise on mount; this makes the heading and the page as a
   whole arrive together instead of popping in.
5. **Reveal on scroll, everywhere** — the existing `Reveal`
   (IntersectionObserver, opacity + 14 px rise, 0.6 s) is extended
   from landing + Ledger to every app page: Invoices, NewInvoice,
   Pay, Portal, Spend Guard, Retainers, About, Docs, FAQ, Public
   invoice. Each content card reveals as it enters the viewport.
6. **Hover micro-interactions, unified** — every card, stat, table
   row, pill, and button gets the same lift (translateY −2 px,
   soft shadow, 0.2 s). Ledger rows already had a hover tint; stat
   cards now lift like the other cards. Transform/opacity only.
7. **Hero scroll drift (subtle, progressive enhancement)** — the
   landing hero drifts up 24 px and fades to 0.4 opacity as it
   scrolls out of view, driven by CSS scroll-driven animation
   (`animation-timeline: view()`, guarded by `@supports`, so
   unsupported browsers simply show a static hero). Disabled under
   `prefers-reduced-motion`.

## Patterns considered and rejected

- **Parallax layers / scrubbed pinning** — too cinematic for a
  ledger; pins trap scroll on phones and fight the form pages.
- **Horizontal scroll sections** — an Awwwards staple, wrong for a
  product: it hides content behind an unfamiliar gesture.
- **GSAP / Framer Motion / any new library** — the whole set above
  is achievable with CSS + one IntersectionObserver; a library
  would add bundle weight for no new effect.
- **Looping or decorative motion** — motion with no purpose reads
  as noise on a bookkeeping tool. Every animation here is tied to
  a user action (scroll, navigation, data arriving).

## Performance and accessibility rules applied

- Animate `transform` and `opacity` only. Never animate width,
  margin, or any layout property.
- Scroll listeners are passive and rAF-throttled; the progress bar
  writes one `scaleX` per frame at most.
- `prefers-reduced-motion: reduce` turns off every new animation
  (reveal, stagger, count-up, progress bar, route entrance, hero
  drift, hover lifts). Colours stay: the card tints are static
  CSS, not motion, so they remain visible with motion off.
- Count-up never invents a number: it always lands exactly on the
  true on-chain value.
- Forms are untouched by motion while typing: reveals fire once on
  mount/scroll-in and then hold `transform: none`, so no layout
  shift can happen while an input has focus.
