import { useState } from 'react';
import type { RegistrationKind } from '@/modules/partnership/api';
import { PartnershipTemplate } from '../partnership/PartnershipTemplate';
import { ServiceProvider } from '../partnership/shared';

/**
 * The Checklist Template tab in the GST module.
 *
 * Four masters live behind this tab — the one-time GST Registration and the
 * three recurring returns — because they're four checklists the firm edits
 * separately. The sub-nav picks which one; the editor beneath it is the same
 * shared PartnershipTemplate component, re-rooted in a ServiceProvider so it
 * reads the chosen kind's template through the /api/{base}/template endpoint.
 *
 * Nested ServiceProvider is intentional: GstShell wraps this whole subtree in
 * ServiceProvider(kind=GST) for the Registration tab; the innermost provider
 * wins, so switching sub-nav here does not leak into GstShell's other tabs.
 */
const CHOICES: { kind: RegistrationKind; label: string }[] = [
  { kind: 'GST', label: 'GST Registration' },
  { kind: 'GSTR1', label: 'GSTR-1' },
  { kind: 'GSTR2B', label: 'IMS + GSTR-2B' },
  { kind: 'GSTR3B', label: 'GSTR-3B' },
];

export function GstTemplateHub() {
  const [kind, setKind] = useState<RegistrationKind>('GST');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-200 pb-2">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 mr-2">Template for</span>
        {CHOICES.map((c) => (
          <button
            key={c.kind}
            type="button"
            onClick={() => setKind(c.kind)}
            className={
              'px-3 h-8 text-13 rounded border ' +
              (kind === c.kind
                ? 'bg-neutral-900 text-white border-neutral-900'
                : 'bg-white text-neutral-700 border-neutral-300 hover:border-neutral-400')
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      <ServiceProvider kind={kind}>
        <PartnershipTemplate />
      </ServiceProvider>
    </div>
  );
}
