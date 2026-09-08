import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X, ChevronRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyApi, type TallyGroupTreeNode } from '@/modules/tools/audit-automation/tally';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/tally/companies/:companyId/masters/groups
 * — expandable group tree, seeded with 17 primaries per company.
 * Primary groups can't be renamed or deleted.
 */
export function TallyGroups() {
  const { companyId = '' } = useParams();
  const [showNew, setShowNew] = useState<{ parentId?: string; parentName?: string } | null>(null);

  const q = useQuery({
    queryKey: ['tally.group-tree', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.groupTree(companyId),
  });

  return (
    <div data-testid="tally-groups">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-16 font-semibold text-neutral-900">Groups</h2>
          <p className="text-12 text-neutral-500 mt-0.5">
            The account tree — primary groups are seeded and can't be deleted. Sub-groups inherit nature from their parent.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowNew({})}>
          <Plus size={14} strokeWidth={1.75} className="mr-1" /> Sub-group
        </Button>
      </header>

      <div className="bg-white border border-neutral-200 rounded p-3">
        {q.isLoading ? (
          <div className="text-13 text-neutral-500 p-3">Loading…</div>
        ) : (q.data?.tree ?? []).length === 0 ? (
          <div className="text-13 text-neutral-500 p-3">No groups yet.</div>
        ) : (
          <ul className="space-y-0.5">
            {(q.data?.tree ?? [])
              .slice()
              .sort((a, b) => (a.is_primary === b.is_primary ? a.name.localeCompare(b.name) : a.is_primary ? -1 : 1))
              .map((node) => (
                <GroupNode key={node.id} node={node} depth={0} onAddSub={(id, name) => setShowNew({ parentId: id, parentName: name })} />
              ))}
          </ul>
        )}
      </div>

      {showNew ? (
        <NewGroupModal
          companyId={companyId}
          parentId={showNew.parentId}
          parentName={showNew.parentName}
          onClose={() => setShowNew(null)}
        />
      ) : null}
    </div>
  );
}

function GroupNode({ node, depth, onAddSub }: {
  node: TallyGroupTreeNode;
  depth: number;
  onAddSub: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div
        className="flex items-center gap-2 h-8 px-2 rounded hover:bg-neutral-50 text-13"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
          className={'text-neutral-400 hover:text-neutral-700 ' + (hasChildren ? '' : 'invisible')}
        >
          {open ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
        </button>
        <span className={'flex-1 truncate ' + (node.is_primary ? 'text-neutral-900 font-medium' : 'text-neutral-800')}>
          {node.name}
        </span>
        <span className="text-11 text-neutral-400 uppercase tracking-wide">{node.nature}</span>
        {node.is_primary ? <span className="text-10 text-amber-700 bg-amber-50 px-1 rounded">Primary</span> : null}
        <button
          type="button"
          onClick={() => onAddSub(node.id, node.name)}
          className="text-11 text-gold hover:text-gold-hover font-medium ml-1"
        >
          + Sub
        </button>
      </div>
      {open && hasChildren ? (
        <ul className="space-y-0.5">
          {node.children
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => <GroupNode key={c.id} node={c} depth={depth + 1} onAddSub={onAddSub} />)}
        </ul>
      ) : null}
    </li>
  );
}

function NewGroupModal({ companyId, parentId, parentName, onClose }: {
  companyId: string;
  parentId?: string;
  parentName?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [nature, setNature] = useState<'assets' | 'liabilities' | 'income' | 'expenses'>('assets');
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => tallyApi.createGroup(companyId, {
      name: name.trim(),
      parent_group_id: parentId ?? null,
      nature: parentId ? undefined : nature,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.group-tree', companyId] });
      toast.push('success', `Group "${name}" created.`);
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) { setErr('Group name is required.'); return; }
    create.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded shadow-lg w-full max-w-[420px]">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between">
          <h2 className="text-14 font-semibold text-neutral-900">
            New group{parentName ? ` under ${parentName}` : ''}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="block text-13 font-medium text-neutral-900 mb-1">Name <span className="text-danger">*</span></span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              placeholder="e.g. Office Equipment"
              autoFocus
            />
          </label>
          {!parentId ? (
            <label className="block">
              <span className="block text-13 font-medium text-neutral-900 mb-1">Nature</span>
              <select
                value={nature}
                onChange={(e) => setNature(e.target.value as typeof nature)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              >
                <option value="assets">Assets</option>
                <option value="liabilities">Liabilities</option>
                <option value="income">Income</option>
                <option value="expenses">Expenses</option>
              </select>
            </label>
          ) : (
            <p className="text-12 text-neutral-500">Nature is inherited from {parentName}.</p>
          )}
          {err ? <div className="text-13 text-danger">{err}</div> : null}
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create group'}
          </Button>
        </div>
      </form>
    </div>
  );
}
