import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/**
 * The application viewport.
 *
 * This shell owns exactly one scroll region: <main>. Everything else is
 * pinned. Three things make that work, and removing any one of them silently
 * reverts to the whole page scrolling:
 *
 *   1. `h-dvh` (not `min-h-screen`) — the shell is exactly one viewport tall
 *      and cannot grow with its content. `dvh` rather than `vh` so mobile
 *      browsers' collapsing address bar doesn't leave a dead strip.
 *   2. `overflow-hidden` on the root — nothing can spill out and make the
 *      body a second scroller, which is what produces a double scrollbar.
 *   3. `min-h-0` on the flex column — a flex item defaults to
 *      `min-height: auto`, which means it grows to fit its content and
 *      `flex-1` never constrains it. Without this, `overflow-y-auto` on
 *      <main> has an unbounded box to work with and does nothing at all.
 *
 * The sidebar and top bar are siblings of the scroll region, not ancestors of
 * it, so they cannot move when it scrolls.
 *
 * Below `lg` the sidebar becomes an off-canvas drawer and leaves the flow, so
 * the content column simply takes the whole viewport — no width juggling. The
 * drawer's open state lives here because its trigger (the top bar) and its
 * target (the sidebar) are siblings; this is their nearest common owner.
 *
 * Because the root is `h-dvh overflow-hidden`, the page behind an open drawer
 * cannot scroll, so no body-scroll lock is needed.
 */
export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="h-dvh flex overflow-hidden bg-neutral-50">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        {/* Padding steps down on small screens — 24px of gutter on a 390px
            phone is 12% of the viewport spent on nothing. */}
        <main className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
