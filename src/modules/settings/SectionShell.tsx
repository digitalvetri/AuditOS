/**
 * Small wrapper each Settings section reuses. Header + optional Add button +
 * body slot. Keeps every section's chrome identical without a big framework.
 */
import type { ReactNode } from 'react';
import { Button } from '@/components/Button';

interface Props {
  title: string;
  description?: string;
  addLabel?: string;
  onAdd?: () => void;
  children: ReactNode;
}

export function SectionShell({ title, description, addLabel, onAdd, children }: Props) {
  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-16 text-neutral-900 font-medium">{title}</h2>
          {description ? <p className="text-13 text-neutral-500 mt-1">{description}</p> : null}
        </div>
        {onAdd && addLabel ? (
          <Button variant="primary" onClick={onAdd} data-testid={`settings-add`}>
            {addLabel}
          </Button>
        ) : null}
      </header>
      {children}
    </section>
  );
}
