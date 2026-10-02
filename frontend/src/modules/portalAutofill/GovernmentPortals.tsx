/**
 * The CRM's portal launchers: a card of registration buttons for one client
 * (client page) and a single "Open & autofill" button (registration page).
 * Both call openGovernmentPortal — client + registration + portal, always.
 */
import { useState } from 'react';
import { ExternalLink, KeyRound, ShieldCheck } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { PORTALS, openGovernmentPortal, useAutofillExtension, type LaunchOutcome } from './api';

function describe(o: LaunchOutcome): { tone: 'success' | 'error' | 'info'; text: string } {
  if (o.kind === 'error') return { tone: 'error', text: o.message };
  if (o.kind === 'plain') return { tone: 'info', text: 'Portal opened. Install the AuditOS autofill extension to fill the login automatically.' };
  if (!o.credentialReady) return { tone: 'info', text: `Portal opened for ${o.clientName}, but no ${o.registrationName} login is saved for this client.` };
  return { tone: 'success', text: o.status === 'SUPPORTED' || o.status === 'PARTIAL'
    ? `Opening ${o.registrationName} for ${o.clientName}. Open the portal’s login — ${o.clientName}’s login fills in by itself.`
    : `Opening ${o.registrationName} for ${o.clientName}. Open the portal’s login — it fills in as soon as the form appears.` };
}

function ExtensionStatus({ present }: { present: boolean }) {
  return present ? (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-11 font-semibold bg-[#ecfdf5] text-[#047857]">
      <span className="rounded-full" style={{ width: 6, height: 6, background: '#10b981' }} />Autofill extension connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-11 font-semibold bg-[#f1f5f9] text-[#475569]" title="Load extension/dist in chrome://extensions (Developer mode → Load unpacked)">
      <span className="rounded-full" style={{ width: 6, height: 6, background: '#94a3b8' }} />Extension not installed — portals open without autofill
    </span>
  );
}

/** Client page: every registration's portal for this client. */
export function GovernmentPortalsCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const toast = useToast();
  const present = useAutofillExtension();
  const [busy, setBusy] = useState<string | null>(null);
  const launch = async (p: (typeof PORTALS)[number]) => {
    setBusy(p.registrationId);
    const o = await openGovernmentPortal({ clientId, portalId: p.portalId, registrationId: p.registrationId, extension: present });
    setBusy(null);
    const d = describe(o);
    toast.push(d.tone, d.text);
  };
  return (
    <section className="dash-card p-5 mb-5" aria-label="Government portals">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center" style={{ background: '#eef0ff', color: '#4338ca', boxShadow: 'inset 0 0 0 1px #dcdffb' }}>
          <KeyRound size={16} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-14 font-semibold text-neutral-900">Government portals</h2>
          <p className="text-12 text-neutral-500">Opens the official portal with {clientName}’s saved login. You complete CAPTCHA / OTP / MFA / DSC.</p>
        </div>
        <ExtensionStatus present={present} />
      </div>
      <div className="flex flex-wrap gap-2">
        {PORTALS.map((p) => (
          <button key={p.registrationId} type="button" disabled={busy !== null} onClick={() => void launch(p)}
            className="h-9 px-3 inline-flex items-center gap-2 text-13 font-medium rounded-lg border border-neutral-200 bg-white text-primary hover:border-primary/40 hover:bg-[#f4f7fc] disabled:opacity-60">
            <ExternalLink size={14} strokeWidth={2} />
            {busy === p.registrationId ? 'Opening…' : p.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-1 text-11 text-neutral-500"><ShieldCheck size={13} /> Only this client’s login for the chosen registration is used — never another client’s.</span>
      </div>
    </section>
  );
}

/** Registration page (step 2): Open & autofill for the chosen client. */
export function OpenWithAutofill({ clientId, registrationId, portalId }: { clientId: string; registrationId: string; portalId: string }) {
  const toast = useToast();
  const present = useAutofillExtension();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy}
        onClick={async () => {
          setBusy(true);
          const o = await openGovernmentPortal({ clientId, portalId, registrationId, extension: present });
          setBusy(false);
          const d = describe(o);
          toast.push(d.tone, d.text);
        }}
        className="inline-flex items-center gap-2 h-10 px-5 text-14 font-medium rounded-lg shadow-card text-white bg-primary hover:bg-primaryHover disabled:opacity-60">
        <KeyRound size={16} strokeWidth={2} />
        {busy ? 'Opening…' : 'Open & autofill login'}
      </button>
      <ExtensionStatus present={present} />
    </div>
  );
}
