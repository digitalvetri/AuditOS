import { forwardRef, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, error, id, className = '', ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <label htmlFor={inputId} className="block">
      {label ? (
        <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">
          {label}
        </span>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={
          'block w-full h-10 px-3 text-14 bg-surface text-ink ' +
          'border border-border rounded-md ' +
          'focus:outline-none focus:border-gold ' +
          (error ? 'border-danger ' : '') +
          className
        }
        {...rest}
      />
      {error ? <span className="block text-12 text-danger mt-1">{error}</span> : null}
    </label>
  );
});
