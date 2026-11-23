/**
 * Employee → Page access. One tick per sidebar page, grouped by block.
 *
 * The role gives a starting set. Here an Admin decides for this one login:
 *   - untick a page the role gives → switched off (hidden_pages);
 *   - tick a page the role does not give → switched on (extra_pages).
 * Settings is the exception: it comes with the role only.
 * The backend (src/platform/pages.ts) enforces both.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { scopeSatisfies, type Grant } from '@/platform/rbac/matrix';
import { buildNav, MODULE_META, type Allow, type ModuleKey } from '@/shell/v2/Sidebar';
import { employeeApi, type PageAccess } from './api';

const same = (a: Set<string>, b: string[]) => a.size === b.length && b.every((k) => a.has(k));

export function PageAccessTab({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['employee', employeeId, 'page-access'], queryFn: () => employeeApi.getPageAccess(employeeId) });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<Set<string>>(new Set());
  const reset = (d: PageAccess) => { setHidden(new Set(d.hidden_pages)); setExtra(new Set(d.extra_pages)); };
  useEffect(() => { if (q.data) reset(q.data); }, [q.data]);

  // Every page of every block; `visible` = the role gives it.
  const blocks = useMemo(() => {
    if (!q.data) return [];
    const grants = q.data.role_grants as Grant[];
    const allow: Allow = (p, sc = 'self') => grants.some((g) => g.permission === p && scopeSatisfies(g.scope, sc));
    return buildNav(undefined, { employee: {} }, { allow, keepHidden: true, keepInvisible: true })
      .filter((g): g is typeof g & { label: ModuleKey } => !!g.label && g.label in MODULE_META)
      .map((g) => ({ key: g.label, title: MODULE_META[g.label].title, pages: g.items }));
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => employeeApi.setPageAccess(employeeId, [...hidden], [...extra]),
    onSuccess: (res) => {
      qc.setQueryData(['employee', employeeId, 'page-access'], res);
      toast.push('success', `Page access saved for ${employeeName}. It applies the next time they open or refresh AuditOS.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (q.isLoading) return <div className="text-13 text-neutral-500">Loading…</div>;
  if (q.isError || !q.data) return <div className="text-13 text-red-700">{(q.error as Error)?.message ?? 'Could not load page access.'}</div>;

  const data = q.data;
  const grantable = new Set(data.grantable_pages);
  const dirty = !same(hidden, data.hidden_pages) || !same(extra, data.extra_pages);
  const isOn = (p: { page: string; visible: boolean }) => (p.visible ? !hidden.has(p.page) : extra.has(p.page));
  const canToggle = (p: { page: string; visible: boolean }) => p.visible || grantable.has(p.page);
  const set = (p: { page: string; visible: boolean }, on: boolean) => {
    if (p.visible) setHidden((cur) => { const n = new Set(cur); if (on) n.delete(p.page); else n.add(p.page); return n; });
    else setExtra((cur) => { const n = new Set(cur); if (on) n.add(p.page); else n.delete(p.page); return n; });
  };

  return (
    <div className="space-y-4" data-testid="page-access">
      <div className="bg-white border border-neutral-200 rounded p-4 flex flex-wrap items-center gap-3 justify-between">
        <div className="text-13 text-neutral-700 max-w-[680px]">
          Tick the pages <b>{employeeName}</b> can open. Their role, <b>{data.role.name}</b>, gives a starting set;
          pages marked <b>Beyond role</b> are extra for this person only. Settings comes with the role only.
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={hidden.size === 0 && extra.size === 0} onClick={() => { setHidden(new Set()); setExtra(new Set()); }}>
            Reset to role
          </Button>
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="page-access-save">
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {blocks.map((b) => {
          const toggles = b.pages.filter(canToggle);
          const onCount = toggles.filter(isOn).length;
          const all = toggles.length > 0 && onCount === toggles.length;
          return (
            <section key={b.key} className="bg-white border border-neutral-200 rounded p-4" data-testid={`page-access-${b.key}`}>
              <label className="flex items-center justify-between gap-3 pb-3 border-b border-neutral-200">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox" checked={all} disabled={!toggles.length}
                    ref={(el) => { if (el) el.indeterminate = onCount > 0 && !all; }}
                    onChange={(e) => { const on = e.currentTarget.checked; toggles.forEach((p) => set(p, on)); }}
                    aria-label={`All of ${b.title}`}
                  />
                  <span className="text-14 font-semibold text-neutral-900">{b.title}</span>
                </span>
                <span className="text-12 text-neutral-500 tabular-nums">{onCount} of {b.pages.length} on</span>
              </label>
              <ul className="mt-2 grid gap-1">
                {b.pages.map((p) => {
                  const on = isOn(p);
                  const toggle = canToggle(p);
                  return (
                    <li key={p.page}>
                      <label className={'flex items-center gap-2 py-1 text-13 ' + (toggle ? 'text-neutral-900' : 'text-neutral-400')}>
                        <input type="checkbox" disabled={!toggle} checked={on} onChange={(e) => set(p, e.currentTarget.checked)} />
                        <span>{p.label}</span>
                        {p.section ? <span className="text-12 text-neutral-500">· {p.section}</span> : null}
                        {!p.visible && toggle ? <span className="ml-auto text-12 text-neutral-500">Beyond role</span> : null}
                        {!toggle ? <span className="ml-auto text-12">Role only</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
