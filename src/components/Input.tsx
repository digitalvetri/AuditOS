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
        <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
          {label}
        </span>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={
          'block w-full h-8 px-3 text-13 bg-white text-neutral-900 ' +
          'border border-neutral-300 rounded ' +
          'focus:outline-none focus:border-gold ' +
          (error ? 'border-red ' : '') +
          className
        }
        {...rest}
      />
      {error ? <span className="block text-12 text-red mt-1">{error}</span> : null}
    </label>
  );
});
