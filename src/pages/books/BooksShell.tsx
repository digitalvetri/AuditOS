import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BooksOrgProvider, useBooks } from '@/modules/books/components';

/**
 * /books/:orgId — the frame every Books screen renders inside: which set of
 * books, and the tabs the caller's role allows.
 */
export function BooksShell() {
  const { orgId } = useParams();
  return (
    <div className="max-w-[1400px] mx-auto" key={orgId}>
      <Link to="/books" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ArrowLeft size={14} strokeWidth={1.75} />All client books
      </Link>
      <BooksOrgProvider>{() => <Frame />}</BooksOrgProvider>
    </div>
  );
}

function Frame() {
  const { org, orgId, canReports, canAccountant, canSettings } = useBooks();
  const tabs: { to: string; label: string; end?: boolean }[] = [
    { to: `/books/${orgId}`, label: 'Overview', end: true },
    { to: `/books/${orgId}/sales`, label: 'Sales' },
    { to: `/books/${orgId}/purchases`, label: 'Purchases' },
    { to: `/books/${orgId}/contacts`, label: 'Contacts' },
    { to: `/books/${orgId}/banking`, label: 'Banking' },
    ...(canAccountant ? [{ to: `/books/${orgId}/journals`, label: 'Journals' }] : []),
    ...(canReports ? [{ to: `/books/${orgId}/reports`, label: 'Reports' }] : []),
    ...(canSettings ? [{ to: `/books/${orgId}/settings`, label: 'Settings' }] : []),
  ];

  return (
    <>
      <header className="flex flex-wrap items-start gap-4 mb-4">
        <div className="min-w-0">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Books</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">{org.name}</h1>
          <p className="text-13 text-neutral-500 mt-1">
            {org.gstin ? `GSTIN ${org.gstin}` : 'No GSTIN'}{org.state_name ? ` · ${org.state_name}` : ''} · {org.base_currency}
            {org.my_role ? <span className="ml-2 text-neutral-400">You are {org.my_role === 'admin' ? 'an admin' : `a ${org.my_role}`}</span> : null}
          </p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-neutral-200 mb-4" aria-label="Books sections">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => 'px-3 h-9 inline-flex items-center text-13 border-b-2 -mb-px ' + (isActive ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </>
  );
}
