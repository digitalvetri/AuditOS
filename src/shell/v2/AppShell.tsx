/**
 * UI-BUILD-PROMPT §2 layout.
 *
 * Sidebar (246/64px) + main. Top bar 64px sticky. Content 24px padding, no
 * max-width. Canvas background. Two-column dashboard grid lives inside the
 * content — the shell only provides the frame.
 *
 * Keeps the shipped app's responsive discipline: single-scroll region on
 * <main>, no double scrollbars, drawer nav below `lg`.
 */
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { MobileNav } from './MobileNav';

export function AppShellV2() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="h-dvh flex overflow-hidden bg-canvas text-ink">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        {/* `m-main` adds bottom-nav clearance and safe-area gutters below
            768px and is inert above it, so desktop padding is unchanged. */}
        <main className="m-main flex-1 min-h-0 overflow-y-auto p-3 md:p-5 lg:p-6">
          <Outlet />
        </main>
      </div>
      {/* Below `md` only. The drawer stays the overflow for everything the
          five slots can't hold. */}
      <MobileNav onOpenMore={() => setMobileNavOpen(true)} />
    </div>
  );
}
