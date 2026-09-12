import { Modal } from '@/modules/workstation/components';
import { HANDOFF_CONFIGS, type HandoffOperationId } from './handoffs';
import type { EinvEwbApplicability, EinvEwbProfile, EwbAlertItem } from './types';

/**
 * The portal-handoff modal — the operator's runbook for a single operation.
 *
 * Shape mirrors the GST handoff (spec §4: "same portal handoff screen, same
 * evidence capture") but supports guards: when a guard forbids the action,
 * the primary CTA is replaced with the reason so the operator does not open
 * the portal only to find they cannot proceed.
 */
export function EInvoiceEwbHandoff({
  operation, clientId, profile, applicability, target, onClose,
}: {
  operation: HandoffOperationId | null;
  clientId: string;
  profile?: EinvEwbProfile;
  applicability?: EinvEwbApplicability;
  target?: EwbAlertItem;
  onClose: () => void;
}) {
  if (!operation) return null;
  const cfg = HANDOFF_CONFIGS[operation];
  const ctx = { clientId, profile, applicability, target };
  const guard = cfg.guard ? cfg.guard(ctx) : { allowed: true };
  const url = cfg.targetUrl(ctx);

  return (
    <Modal open={!!operation} onClose={onClose} title={cfg.title} width="w-[640px]"
      footer={
        <>
          <button type="button" onClick={onClose}
            className="h-8 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50">Close</button>
          {guard.allowed ? (
            <a href={url} target="_blank" rel="noreferrer"
              className="h-8 px-3 text-13 bg-neutral-900 text-white rounded hover:bg-neutral-800 flex items-center">
              Open {cfg.targetLabel}
            </a>
          ) : null}
        </>
      }
    >
      <div className="space-y-3 text-13 text-neutral-900">
        {!guard.allowed ? (
          <div className="border-l-2 border-red pl-3 py-2">
            <div className="font-medium">Blocked</div>
            <p className="text-neutral-500 text-12 mt-1">{guard.reason}</p>
          </div>
        ) : null}

        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Portal</div>
          <div>{cfg.targetLabel} · {cfg.preLogin ? 'pre-login page' : 'post-login page'}</div>
          <div className="text-12 text-neutral-500 mt-1">{cfg.navPath.join(' › ')}</div>
        </div>

        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">MFA</div>
          <div className="text-12 text-neutral-500">{cfg.mfaNote}</div>
        </div>

        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Steps</div>
          <ol className="list-decimal ml-4 space-y-1">
            {cfg.instructions.map((s, i) => <li key={i} className="text-13 text-neutral-900">{s}</li>)}
          </ol>
        </div>

        {cfg.fields && cfg.fields.length > 0 ? (
          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Fields to fill on the portal</div>
            <ul className="ml-4 list-disc text-13 text-neutral-900 space-y-1">
              {cfg.fields.map((f) => (
                <li key={f.key}>{f.label}{f.required ? ' *' : ''}{f.hint ? ` — ${f.hint}` : ''}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {cfg.capture && cfg.capture.length > 0 ? (
          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Capture back into Audit OS</div>
            <ul className="ml-4 list-disc text-13 text-neutral-900 space-y-1">
              {cfg.capture.map((f) => (
                <li key={f.key}>{f.label}{f.required ? ' *' : ''}{f.hint ? ` — ${f.hint}` : ''}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
