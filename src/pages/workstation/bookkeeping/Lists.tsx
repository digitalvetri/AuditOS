import { useQuery } from '@tanstack/react-query';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { human } from '@/modules/bookkeeping/format';
import { Card, PageHeader, QueryState } from '@/modules/workstation/components';

/**
 * BOOKKEEPING SETTINGS.
 *
 * The vocabulary the module validates against, served by the API so the
 * dropdowns and the server can never drift apart.
 *
 * The five list-style pages that used to live here (Tasks · Pending Items ·
 * Documents · Deliverables · Reminders) were retired by spec §3 — every one
 * of them is now a filter on Overview or a sub-tab inside Monthly Work.
 * See `App.tsx` for the redirect entries that keep old bookmarks alive.
 */
export function BookkeepingSettingsPage() {
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });
  return (
    <div>
      <PageHeader title="Settings" subtitle="The vocabulary this module validates against, served by the API." />
      <QueryState query={settings}>
        {(s) => (
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Workflow stages">
              <ol className="px-4 py-3 space-y-1">
                {(s.workflow_stages ?? []).map((stage) => (
                  <li key={stage.id} className="text-13 text-neutral-700 flex gap-2 items-baseline">
                    <span className="text-neutral-400 tabular-nums w-5">{stage.sequence}.</span>
                    <span className="flex-1">{stage.name}</span>
                    <span className="text-11 text-neutral-500">{human(stage.default_category)}</span>
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="Task categories">
              <div className="px-4 py-3 flex flex-wrap gap-1">
                {s.task_categories.map((c) => (
                  <span key={c} className="text-12 px-2 py-0.5 border border-neutral-200 rounded text-neutral-600">{human(c)}</span>
                ))}
              </div>
            </Card>
            <Card title="Pending item categories">
              <div className="px-4 py-3 flex flex-wrap gap-1">
                {s.pending_categories.map((c) => (
                  <span key={c} className="text-12 px-2 py-0.5 border border-neutral-200 rounded text-neutral-600">{human(c)}</span>
                ))}
              </div>
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
