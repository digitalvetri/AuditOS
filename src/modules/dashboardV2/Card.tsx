/**
 * UI-BUILD-PROMPT §6 Card.
 *
 *   <Card title="Expenses to action" action={{ label: 'Open Queue', href: '/expenses' }}>
 *
 * Surface background, 1px border, 10px radius, card shadow, 20px padding.
 * Title 13px 600 uppercase 0.06em on the left; optional action link on the
 * right in gold with a ChevronRight.
 *
 * Every card renders loading / empty / error states. Loading is a static
 * border-coloured block — no shimmer animation.
 */
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface Action {
  label: string;
  href: string;
}
interface Props {
  title: string;
  action?: Action;
  className?: string;
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyMessage?: string;
  'data-testid'?: string;
}

export function Card({
  title, action, className = '', children, loading, error, empty, emptyMessage,
  ...rest
}: Props) {
  return (
    <section
      className={'bg-surface border border-border rounded-lg shadow-card p-5 ' + className}
      data-testid={rest['data-testid']}
    >
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-13 font-semibold uppercase tracking-[0.06em] text-ink">{title}</h2>
        {action ? (
          <Link
            to={action.href}
            className="inline-flex items-center gap-1 text-12 font-medium text-gold hover:text-gold-hover"
          >
            {action.label}
            <ChevronRight size={14} strokeWidth={1.75} />
          </Link>
        ) : null}
      </header>
      {loading ? <LoadingBlock /> :
       error ? <ErrorBlock message={error} /> :
       empty ? <EmptyBlock message={emptyMessage ?? 'Nothing to show yet.'} /> :
       children}
    </section>
  );
}

function LoadingBlock() {
  // Static border-coloured block — NO shimmer. UI-BUILD-PROMPT §6 rule.
  return <div className="h-16 rounded-md bg-border" aria-label="Loading" />;
}
function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="text-13 text-danger" role="alert">
      {message}
    </div>
  );
}
function EmptyBlock({ message }: { message: string }) {
  return <div className="text-13 text-inkMuted">{message}</div>;
}
