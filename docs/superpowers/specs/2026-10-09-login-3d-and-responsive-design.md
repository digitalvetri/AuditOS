# Login 3D scene + product-wide responsiveness — design

Date: 2026-10-09 · Status: approved
Reference: the user's mockup `JNS7 Accounting Solutions Login.png` (1554×1012).

## Decisions

| Topic | Decision |
|---|---|
| 3D scene | The desk illustration from the mockup (laptop, mug, plant, window, lamp), cropped to the area right of the baked-in text, used as hero artwork with CSS-only depth motion. No 3D library. |
| Text | Headline, description and the three feature cards are real HTML, not part of the image. The tagline "Smarter Accounting / Brighter Tomorrow" stays baked into the image. |
| Language picker | Left out (app is English-only). |
| Phone login | Short animated scene banner with logo + tagline, then the sign-in card. |
| Sharpness | The crop is ~450 px wide; swap in a clean ≥2000 px export when the user provides one (one file, no code change). |

## Login page

**Desktop (≥ 900 px, two columns)**
- Left panel: lavender gradient; logo chip + "Accounting Solutions"; serif headline "Your whole practice, *in one place.*" (gradient italic); description; three glass feature cards with icons (ShieldCheck — GST & TDS, FileText — Clients & billing, Users — People); © line. The scene sits on the right ~60 % of the panel with a left-edge fade mask so text stays readable.
- Motion (CSS + a small pointer handler, `prefers-reduced-motion` turns it all off):
  - pointer parallax: CSS vars `--px/--py` (−1…1) set on pointermove, rAF-throttled; scene layer moves ±8 px, glow orbs ±18 px, cards tilt `rotateX/rotateY` ±4° under `perspective`.
  - cards float on staggered 6–7 s keyframes; lamp glow pulses (radial gradient, 5 s); scene fades/rises in on load (700 ms).
  - touch devices: a slow automatic drift instead of pointer tracking.
- Right panel: soft corner blobs; frosted card (white 80 %, blur, 1 px lavender border, 24 px radius); logo, "Welcome back", "Sign in to your workspace and stay productive."; fields with leading Mail / Lock icons and the eye toggle; Remember me + Forgot password? (existing ask-your-Admin note); gradient button (#5b4cf0 → #a78bfa) "Sign in →"; "or" divider; "Need access? Contact your administrator" bar with ShieldCheck; Privacy | Terms bottom-right.

**Phone / small tablet (< 900 px)**
- Top banner (~200 px, rounded bottom) showing the scene (laptop crop) with logo chip and tagline over a gradient; gentle auto-drift.
- Sign-in card below, full width with 16 px gutters; no horizontal scroll at 360 px.

Dark theme: login keeps its light lavender look (it is a pre-auth brand screen), as today.

## Product-wide responsiveness

- Widths: 360, 390, 768, 1024, 1440.
- A scratch database (`auditos_audit`) seeded with realistic sample data (staff, clients with long names, quotations, invoices, tasks, leave, expenses) — the user's `auditos_local` is never touched.
- Audit script (Playwright, run from the scratchpad, not committed) visits every route as Admin and as an Associate, and reports: document horizontal overflow, elements wider than the viewport, text clipped by `overflow:hidden` with `scrollWidth > clientWidth` on non-table cells, interactive elements smaller than 32 px on phones; saves screenshots.
- Fixes go in component classes or `src/design/mobile.css`, Pastel Bento styling, closed Tailwind scale. Print documents are out of scope.
- Done when the audit reports zero overflow at every width and a visual pass of the main pages looks right; before/after screenshots shared.

## Out of scope
Language switching; three.js; print layouts.
