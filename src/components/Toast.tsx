/**
 * Minimal toast — used by mutations to acknowledge success/failure per §4.5.
 * No animation library, no shimmer. Just a fixed-position card that auto-dismisses.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type ToastVariant = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  variant: ToastVariant;
  text: string;
}
interface ToastContextValue {
  push: (variant: ToastVariant, text: string) => void;
}
const Ctx = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((variant: ToastVariant, text: string) => {
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), variant, text }]);
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((prev) => prev.slice(1)), 4000);
    return () => clearTimeout(t);
  }, [toasts]);

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              'bg-white border-l-2 shadow-drawer rounded px-3 py-2 text-13 min-w-[220px] max-w-[380px] ' +
              (t.variant === 'success' ? 'border-neutral-400 ' : t.variant === 'error' ? 'border-red ' : 'border-amber ')
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used within <ToastProvider>');
  return v;
}
