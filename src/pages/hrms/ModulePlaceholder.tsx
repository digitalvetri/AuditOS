/**
 * Placeholder for HRMS sub-modules that aren't built yet.
 *
 * NOT a reserved screen — reserved screens are for Workstation/Tools only.
 * These are unfinished modules that will be implemented in later sessions.
 * They render deliberately (no dead click, no 404) so the sidebar is
 * navigable end-to-end this session, satisfying §14 "no dead buttons, no
 * dead links, no unimplemented routes" at the shell level.
 */
export function ModulePlaceholder({ name, plannedIn }: { name: string; plannedIn: string }) {
  return (
    <div className="max-w-[720px] mx-auto">
      <div className="bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">{name}</h1>
        <p className="text-13 text-neutral-500 mt-2">
          Module scheduled for {plannedIn}. The route, permission gate and
          navigation entry are wired now so later sessions only need to
          replace the body of this page.
        </p>
      </div>
    </div>
  );
}
