/**
 * PWA surfaces:
 *  · UpdateBar     — "new version ready" (asks; never reloads on its own)
 *  · DeviceCard    — install the app + turn on alerts for this device
 *  · AlertsNudge   — one-line prompt in the bell menu while alerts are off
 */
import { useCallback, useEffect, useState } from 'react';
import { BellRing, Download, RefreshCw, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { usePwa } from './PwaProvider';
import { disablePush, enablePush, pushState, type PushState } from './push';
import { useToast } from '@/components/Toast';

export function UpdateBar() {
  const { updateReady, applyUpdate, dismissUpdate } = usePwa();
  if (!updateReady) return null;
  return (
    <div className="pwa-update fixed z-[70] left-1/2 -translate-x-1/2 bottom-[84px] md:bottom-5 flex items-center gap-3 pl-4 pr-2 h-12 rounded-full bg-primary text-white shadow-drawer max-w-[calc(100vw-24px)]" role="status">
      <RefreshCw size={16} className="shrink-0" />
      <span className="text-13 font-semibold whitespace-nowrap overflow-hidden text-ellipsis">A new version of AuditOS is ready</span>
      <button type="button" onClick={applyUpdate} className="h-8 px-3 rounded-full bg-white text-primary text-12 font-bold shrink-0">Reload</button>
      <button type="button" onClick={dismissUpdate} aria-label="Later" className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 shrink-0"><X size={15} /></button>
    </div>
  );
}

/** Shown while the browser reports no network; disappears on reconnect. */
export function OfflineBar() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  if (online) return null;
  return (
    <div className="pwa-offline fixed z-[70] left-1/2 -translate-x-1/2 top-3 flex items-center gap-2 px-4 h-9 rounded-full bg-warning text-white text-12 font-semibold shadow-drawer" role="status" data-testid="offline-bar">
      <WifiOff size={14} /> You’re offline — changes can’t be saved until the connection is back
    </div>
  );
}

export function usePushState() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => { void pushState().then(setState); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const turnOn = useCallback(async () => {
    setBusy(true);
    try { setState(await enablePush()); } finally { setBusy(false); }
  }, []);
  const turnOff = useCallback(async () => {
    setBusy(true);
    try { setState(await disablePush()); } finally { setBusy(false); }
  }, []);
  return { state, busy, turnOn, turnOff, refresh };
}

const PUSH_HELP: Record<PushState, string> = {
  on: 'Alerts arrive on this device even when AuditOS is closed.',
  off: 'Get a system alert for approvals, assignments, messages and filings — even when the app is closed.',
  denied: 'Notifications are blocked for this site. Allow them in the browser’s site settings (the icon left of the address bar), then come back.',
  insecure: 'Alerts need a secure (https) address. Ask your administrator to serve AuditOS over https.',
  unsupported: 'This browser can’t show system alerts. On iPhone, add AuditOS to the Home Screen first (iOS 16.4+).',
};

export function DeviceCard() {
  const toast = useToast();
  const { installed, canInstall, iosManual, install } = usePwa();
  const { state, busy, turnOn, turnOff } = usePushState();
  const secure = typeof window === 'undefined' || window.isSecureContext;

  const onAlerts = async () => {
    try {
      if (state === 'on') await turnOff();
      else await turnOn();
    } catch (e) {
      toast.push('error', (e as Error).message || 'Could not turn on alerts.');
    }
  };

  return (
    <section className="dash-card bg-white border border-neutral-200 rounded-lg overflow-hidden" data-testid="device-card">
      <div className="px-4 py-3 border-b border-neutral-200 flex items-center gap-2">
        <Smartphone size={16} className="text-inkMuted" />
        <h2 className="text-14 font-bold text-ink">This device</h2>
      </div>
      <div className="grid md:grid-cols-2">
        <div className="p-4 flex items-start gap-3 border-b md:border-b-0 md:border-r border-neutral-200">
          <span className="h-10 w-10 shrink-0 rounded-[12px] grid place-items-center" style={{ background: '#ffe9f0', color: '#e0457b' }}><BellRing size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-13 font-bold text-ink">Real-time alerts</span>
              {state === 'on' ? <span className="h-5 px-2 rounded-full bg-success/10 text-success text-11 font-semibold grid place-items-center">On</span> : null}
            </div>
            <p className="text-12 text-inkMuted mt-0.5">{state ? PUSH_HELP[state] : 'Checking…'}</p>
            {state === 'on' || state === 'off' ? (
              <button type="button" onClick={onAlerts} disabled={busy} data-testid="push-toggle"
                className={'mt-3 h-9 px-4 rounded-[10px] text-13 font-semibold disabled:opacity-60 ' + (state === 'on' ? 'bg-canvas text-ink border border-border' : 'bg-primary text-white')}>
                {busy ? 'Working…' : state === 'on' ? 'Turn off on this device' : 'Turn on alerts'}
              </button>
            ) : null}
          </div>
        </div>
        <div className="p-4 flex items-start gap-3">
          <span className="h-10 w-10 shrink-0 rounded-[12px] grid place-items-center" style={{ background: '#e6f1ff', color: '#2f6fed' }}><Download size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-13 font-bold text-ink">Install the app</span>
              {installed ? <span className="h-5 px-2 rounded-full bg-success/10 text-success text-11 font-semibold grid place-items-center">Installed</span> : null}
            </div>
            <p className="text-12 text-inkMuted mt-0.5">
              {installed
                ? 'You’re using the installed AuditOS app.'
                : !secure
                  ? 'Installing needs a secure (https) address. Ask your administrator to serve AuditOS over https.'
                  : iosManual
                  ? 'Tap the Share button, then “Add to Home Screen”.'
                  : 'Open AuditOS in its own window from your dock, taskbar or home screen — faster, and works with alerts.'}
            </p>
            {canInstall ? (
              <button type="button" onClick={() => void install()} data-testid="install-app"
                className="mt-3 h-9 px-4 rounded-[10px] bg-primary text-white text-13 font-semibold inline-flex items-center gap-2">
                <Download size={15} /> Install AuditOS
              </button>
            ) : iosManual && secure ? (
              <span className="mt-3 inline-flex items-center gap-2 text-12 font-semibold text-ink"><Share size={14} /> Share → Add to Home Screen</span>
            ) : !installed && secure ? (
              <p className="mt-2 text-11 text-inkFaint">Use the install icon in the browser’s address bar (Chrome / Edge).</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Compact prompt inside the bell menu while alerts are off on this device. */
export function AlertsNudge() {
  const { state, busy, turnOn } = usePushState();
  const toast = useToast();
  if (state !== 'off') return null;
  return (
    <div className="px-4 py-2 flex items-center gap-2 border-b border-border bg-coral/[0.06]">
      <BellRing size={15} className="text-coral shrink-0" />
      <span className="text-12 text-ink flex-1">Get alerts even when AuditOS is closed.</span>
      <button type="button" disabled={busy} onClick={() => { turnOn().catch((e: Error) => toast.push('error', e.message || 'Could not turn on alerts.')); }}
        className="h-7 px-3 rounded-full bg-primary text-white text-11 font-bold shrink-0 disabled:opacity-60">Turn on</button>
    </div>
  );
}
