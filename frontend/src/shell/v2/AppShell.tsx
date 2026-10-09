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
import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { RouteErrorBoundary } from '@/components/ErrorBoundary';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { MobileNav } from './MobileNav';
import { RealtimeProvider } from '@/platform/realtime/RealtimeProvider';
import { OfflineBar, UpdateBar } from '@/platform/pwa/PwaUi';
import { QuerySkeleton } from '@/modules/workstation/components';
import { KeyboardShortcuts } from './KeyboardShortcuts';

export function AppShellV2() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <RealtimeProvider>
    <div className="h-dvh flex overflow-hidden bg-canvas text-ink">
      <a href="#main" className="skip-link h-10 px-4 inline-flex items-center rounded-[10px] bg-primary text-white text-13 font-semibold shadow-drawer">Skip to content</a>
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        {/* `m-main` adds bottom-nav clearance and safe-area gutters below
            768px and is inert above it, so desktop padding is unchanged.
            `relative` keeps absolutely positioned content (sr-only file
            inputs) inside this scroller; without it they stretch the
            document and the whole shell scrolls up, leaving a blank band. */}
        <main id="main" tabIndex={-1} className="m-main relative flex-1 min-h-0 overflow-y-auto p-3 md:p-5 lg:p-6 focus:outline-none">
          <RouteErrorBoundary>
            {/* Pages are code-split (App.tsx): the shell stays while one loads. */}
            <Suspense fallback={<QuerySkeleton />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>
      {/* Below `md` only. The drawer stays the overflow for everything the
          five slots can't hold. */}
      <MobileNav onOpenMore={() => setMobileNavOpen(true)} />
      <KeyboardShortcuts />
      <UpdateBar />
      <OfflineBar />
    </div>
    </RealtimeProvider>
  );
}
