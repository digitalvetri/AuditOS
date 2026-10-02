import type { ReactNode } from 'react';

/**
 * Small form primitives for tool option forms. Same tokens as the
 * Workstation kit (h-8 selects, 11px letter-spaced labels), so an options
 * block reads like every other form in the CRM.
 */
export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-12 text-neutral-500 mt-1">{hint}</span> : null}
    </label>
  );
}

export function SelectField<T extends string>({ label, value, onChange, options, hint, className = '' }: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; hint?: ReactNode; className?: string;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export function TextField({ label, value, onChange, placeholder, type = 'text', hint, className = '', autoComplete, error }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; hint?: ReactNode; className?: string; autoComplete?: string; error?: string | null;
}) {
  return (
    <Field label={label} hint={error ? <span className="text-red">{error}</span> : hint} className={className}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={
          'h-8 w-full px-2 text-13 bg-white text-neutral-900 border rounded focus:outline-none focus:border-gold ' +
          (error ? 'border-red' : 'border-neutral-300')
        }
      />
    </Field>
  );
}

export function Checkbox({ checked, onChange, children, className = '' }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={`flex items-start gap-2 text-13 text-neutral-900 cursor-pointer ${className}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-[#C8952E]" />
      <span>{children}</span>
    </label>
  );
}

export function RadioGroup<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[];
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</legend>
      <div className="space-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-13 text-neutral-900 cursor-pointer">
            <input type="radio" name={label} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-1 accent-[#C8952E]" />
            <span>
              {o.label}
              {o.hint ? <span className="block text-12 text-neutral-500">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Plain information on a bordered surface — not an alarm (Workstation §9 pattern). */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const border = tone === 'error' ? 'border-red' : tone === 'warn' ? 'border-amber' : 'border-neutral-400';
  return <div className={`border-l-2 ${border} bg-white px-3 py-2 text-12 text-neutral-600`}>{children}</div>;
}
