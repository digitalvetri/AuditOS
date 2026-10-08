/**
 * Progressive Web App state for the whole UI:
 *
 *  · registers the service worker (never in mock mode — MSW owns that scope)
 *  · "a new version is ready" → the UpdateBar asks before reloading, so a
 *    half-filled builder is never thrown away
 *  · install: Chrome/Edge/Android give us `beforeinstallprompt`; iOS Safari
 *    has no prompt, so we explain Share → Add to Home Screen instead
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaState {
  /** Running as the installed app (standalone window / home-screen). */
  installed: boolean;
  /** The browser can show its own install dialog right now. */
  canInstall: boolean;
  /** iPhone/iPad Safari — install is manual (Share → Add to Home Screen). */
  iosManual: boolean;
  install: () => Promise<boolean>;
  updateReady: boolean;
  applyUpdate: () => void;
  dismissUpdate: () => void;
  /** The service worker controls this page (offline shell + push available). */
  swReady: boolean;
}

const Ctx = createContext<PwaState | null>(null);

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function PwaProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(isStandalone);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [swReady, setSwReady] = useState(false);
  const updateSW = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    (async () => {
      const { registerSW } = await import('virtual:pwa-register');
      if (cancelled) return;
      updateSW.current = registerSW({
        immediate: true,
        onNeedRefresh: () => setUpdateReady(true),
        onRegisteredSW: (_url, reg) => {
          setSwReady(true);
          // Long-lived office tabs: look for a new deploy every 30 minutes.
          if (reg) setInterval(() => { void reg.update().catch(() => {}); }, 30 * 60 * 1000);
        },
      });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setDeferred(null); };
    const mq = window.matchMedia('(display-mode: standalone)');
    const onMode = () => setInstalled(isStandalone());
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    mq.addEventListener('change', onMode);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      mq.removeEventListener('change', onMode);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome === 'accepted';
  }, [deferred]);

  const applyUpdate = useCallback(() => { void updateSW.current?.(true); }, []);
  const dismissUpdate = useCallback(() => setUpdateReady(false), []);

  const value = useMemo<PwaState>(() => ({
    installed,
    canInstall: !installed && !!deferred,
    iosManual: !installed && isIosSafari(),
    install,
    updateReady,
    applyUpdate,
    dismissUpdate,
    swReady,
  }), [installed, deferred, install, updateReady, applyUpdate, dismissUpdate, swReady]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePwa(): PwaState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePwa must be used inside <PwaProvider>');
  return v;
}
