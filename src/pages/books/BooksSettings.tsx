import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/Toast';
import { booksApi, errorText, type BooksConnection, type BooksOrg } from '@/modules/books/api';
import { statusKey, useBooks } from '@/modules/books/context';
import { Badge, Btn, Cell, Empty, Field, Modal, Notice, PageHeader, Row, Section, Select, Table, TextInput, dateTime } from '@/modules/books/ui';

const REASONS: Record<string, string> = {
  invalid_state: 'The sign-in link expired or was not started here. Try connecting again.',
  oauth_failed: 'Zoho did not complete the sign-in. Try connecting again.',
  access_denied: 'Access was denied in Zoho.',
  books_not_configured: 'Zoho Books is not configured on the server.',
};

export function BooksSettingsPage() {
  const { status, can, org } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [confirm, setConfirm] = useState<BooksConnection | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);

  // Result of the OAuth round-trip, reported once.
  useEffect(() => {
    const z = params.get('zoho');
    if (!z) return;
    if (z === 'connected') toast.push('success', 'Zoho Books connected. Choose the organisations to use below.');
    else toast.push('error', REASONS[params.get('reason') ?? ''] ?? `Connecting Zoho Books failed (${params.get('reason') ?? 'unknown'}).`);
    void qc.invalidateQueries({ queryKey: statusKey });
    setParams({}, { replace: true });
  }, [params, setParams, toast, qc]);

  const refresh = () => qc.invalidateQueries({ queryKey: statusKey });
  const go = (p: Promise<{ authorizeUrl: string }>) => p.then((r) => { window.location.assign(r.authorizeUrl); });
  const connect = useMutation({ mutationFn: () => go(booksApi.connect()), onError: (e) => toast.push('error', errorText(e)) });
  const disconnect = useMutation({
    mutationFn: (id: string) => booksApi.disconnect(id),
    onSuccess: () => { setConfirm(null); void refresh(); toast.push('success', 'Zoho Books disconnected.'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const reload = useMutation({ mutationFn: (id: string) => booksApi.refreshOrgs(id), onSuccess: () => void refresh(), onError: (e) => toast.push('error', errorText(e)) });

  const conns = status.connections;
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" subtitle="Zoho Books connection, organisations and sync." right={can.settings && status.configured ? (
        <Btn variant="primary" onClick={() => setCodeOpen(true)}>{conns.some((c) => c.status === 'connected') ? 'Connect another Zoho account' : 'Connect Zoho Books'}</Btn>
      ) : null} />
      {codeOpen ? (
        <ConnectWithCodeModal
          onClose={() => setCodeOpen(false)}
          onDone={() => { setCodeOpen(false); void refresh(); }}
          browserSignIn={{ loading: connect.isPending, start: () => connect.mutate() }}
        />
      ) : null}

      {!status.configured ? <Notice tone="warn">Zoho Books API credentials are not configured on the server (ZBOOKS_CLIENT_ID, ZBOOKS_CLIENT_SECRET, ZBOOKS_REDIRECT_URI). See docs/books-zoho/README.md.</Notice> : null}
      {!can.settings ? <Notice>You can view Books settings. Changing them needs the Books settings permission.</Notice> : null}

      <Section title="Zoho connections">
        {conns.length === 0 ? <Empty title="Zoho Books is not connected">Connect your Zoho Books organisation to start managing your accounting data from Audit OS.</Empty> : (
          <Table cols={[{ label: 'Status' }, { label: 'Data centre' }, { label: 'Connected' }, { label: 'Last error' }, { label: '' }]} minWidth={680}>
            {conns.map((c) => (
              <Row key={c.id}>
                <Cell><Badge status={c.status} /></Cell>
                <Cell muted>{c.data_center?.replace('https://', '') ?? '—'}</Cell>
                <Cell muted>{dateTime(c.connected_at)}</Cell>
                <Cell muted>{c.last_error_code ? `${c.last_error_code} · ${dateTime(c.last_error_at)}` : '—'}</Cell>
                <Cell right>
                  {can.settings ? (
                    <div className="flex justify-end gap-2">
                      {c.status === 'connected' ? <Btn variant="ghost" loading={reload.isPending} onClick={() => reload.mutate(c.id)}>Refresh organisations</Btn> : null}
                      <Btn variant="ghost" onClick={() => setCodeOpen(true)}>Reconnect</Btn>
                      {c.status !== 'disconnected' ? <Btn variant="danger" onClick={() => setConfirm(c)}>Disconnect</Btn> : null}
                    </div>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      <OrganizationsSection />
      {org ? <SyncSection org={org} /> : null}

      {confirm ? (
        <Modal title="Disconnect Zoho Books?" onClose={() => setConfirm(null)} footer={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn><Btn variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate(confirm.id)}>Disconnect</Btn></>}>
          <p className="text-13 text-ink">Audit OS will revoke its access at Zoho and delete the stored tokens. Organisations from this connection stop working in Books until you reconnect. Nothing in Zoho Books is deleted.</p>
        </Modal>
      ) : null}
    </div>
  );
}

function OrganizationsSection() {
  const { status, can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const clients = useQuery({ queryKey: ['books', 'clients'], queryFn: booksApi.clients, enabled: can.settings, staleTime: 60_000 });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof booksApi.updateOrg>[1] }) => booksApi.updateOrg(id, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: statusKey }); toast.push('success', 'Organisation updated.'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const orgs = status.organizations;
  const mapped = new Set(orgs.flatMap((o) => (o.client_id ? [o.client_id] : [])));
  return (
    <Section title="Zoho Books organisations">
      {orgs.length === 0 ? (status.connections.some((c) => c.status === 'connected')
        ? <NoZohoOrganisations />
        : <Empty title="No organisations yet">Organisations appear here once a Zoho account is connected.</Empty>) : (
        <Table cols={[{ label: 'Organisation' }, { label: 'Zoho org ID' }, { label: 'Currency' }, { label: 'Audit OS client' }, { label: 'Connection' }, { label: 'Use in Books' }]} minWidth={860}>
          {orgs.map((o: BooksOrg) => (
            <Row key={o.id}>
              <Cell className="font-medium">{o.name}</Cell>
              <Cell muted className="tabular-nums">{o.zoho_org_id}</Cell>
              <Cell muted>{o.currency_code ?? '—'}</Cell>
              <Cell>
                {can.settings ? (
                  <Select value={o.client_id ?? ''} placeholder="— Not mapped —" disabled={update.isPending}
                    onChange={(v) => update.mutate({ id: o.id, body: { client_id: v || null } })}
                    options={(clients.data?.items ?? []).filter((c) => c.id === o.client_id || !mapped.has(c.id)).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} className="max-w-[260px]" />
                ) : o.client_name ?? '—'}
              </Cell>
              <Cell><Badge status={o.connection_status} /></Cell>
              <Cell>
                {can.settings ? (
                  <label className="inline-flex items-center gap-2 text-13">
                    <input type="checkbox" checked={o.is_active} disabled={update.isPending || (!o.is_active && o.connection_status !== 'connected')} onChange={(e) => update.mutate({ id: o.id, body: { is_active: e.target.checked } })} />
                    {o.is_active ? 'Active' : 'Inactive'}
                  </label>
                ) : o.is_active ? 'Active' : 'Inactive'}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  );
}

function SyncSection({ org }: { org: BooksOrg }) {
  const { can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const logs = useQuery({ queryKey: ['books', org.id, 'sync-logs'], queryFn: () => booksApi.org(org.id).syncLogs() });
  const update = useMutation({
    mutationFn: (m: number) => booksApi.updateOrg(org.id, { auto_refresh_minutes: m }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: statusKey }); toast.push('success', 'Sync setting saved.'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  return (
    <Section title={`Sync — ${org.name}`} right={can.settings ? (
      <div className="flex items-center gap-2 text-12 text-inkMuted">
        Refresh dashboard automatically
        <Select value={String(org.auto_refresh_minutes)} onChange={(v) => update.mutate(Number(v))} className="w-40"
          options={[{ value: '0', label: 'Manual only' }, { value: '30', label: 'Every 30 min' }, { value: '60', label: 'Every hour' }, { value: '240', label: 'Every 4 hours' }, { value: '1440', label: 'Daily' }]} />
      </div>
    ) : null}>
      <div className="px-4 py-3 text-13 text-inkMuted flex flex-wrap gap-x-6 gap-y-1">
        <span>Status: <Badge status={org.sync_status} /></span>
        <span>Last successful sync: {dateTime(org.last_sync_at)}</span>
        <span>Last attempt: {dateTime(org.last_sync_attempt_at)}</span>
        <span>Activated: {dateTime(org.activated_at)}</span>
      </div>
      {org.last_sync_error ? <div className="px-4 pb-3"><Notice tone="error">Last error: {org.last_sync_error}</Notice></div> : null}
      <Table cols={[{ label: 'Started' }, { label: 'Trigger' }, { label: 'Result' }, { label: 'API calls', right: true }, { label: 'Error' }]} minWidth={640}>
        {(logs.data?.items ?? []).map((l) => (
          <Row key={l.id}>
            <Cell muted>{dateTime(l.started_at)}</Cell>
            <Cell muted className="capitalize">{l.trigger}</Cell>
            <Cell><Badge status={l.status === 'succeeded' ? 'synced' : l.status} /></Cell>
            <Cell right muted>{l.api_calls}</Cell>
            <Cell muted>{l.error ?? '—'}</Cell>
          </Row>
        ))}
        {logs.data && logs.data.items.length === 0 ? <Row><Cell colSpan={5} muted>No syncs yet.</Cell></Row> : null}
      </Table>
    </Section>
  );
}

const DATA_CENTRES = [
  { value: 'https://accounts.zoho.in', label: 'India — zoho.in' },
  { value: 'https://accounts.zoho.com', label: 'US — zoho.com' },
  { value: 'https://accounts.zoho.eu', label: 'Europe — zoho.eu' },
  { value: 'https://accounts.zoho.com.au', label: 'Australia — zoho.com.au' },
  { value: 'https://accounts.zoho.jp', label: 'Japan — zoho.jp' },
  { value: 'https://accounts.zohocloud.ca', label: 'Canada — zohocloud.ca' },
  { value: 'https://accounts.zoho.sa', label: 'Saudi Arabia — zoho.sa' },
];

/**
 * Connect without the browser redirect: the firm generates a one-time grant
 * code in the Zoho API console (Self Client → Generate Code) and pastes it.
 * Works whatever redirect URI the Zoho client has, including none.
 */
function ConnectWithCodeModal({ onClose, onDone, browserSignIn }: { onClose: () => void; onDone: () => void; browserSignIn: { loading: boolean; start: () => void } }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [dc, setDc] = useState(DATA_CENTRES[0].value);
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => booksApi.connectWithCode(code.trim(), dc),
    onSuccess: (r) => {
      toast.push('success', `Zoho Books connected — ${r.organizations} organisation${r.organizations === 1 ? '' : 's'} found. Activate the ones to use below.`);
      onDone();
    },
    onError: (e) => setError(errorText(e)),
  });
  const console_ = dc.replace('accounts.', 'api-console.');
  return (
    <Modal title="Connect Zoho Books" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!code.trim()} loading={submit.isPending} onClick={() => { setError(null); submit.mutate(); }}>Connect</Btn></>}>
      <div className="space-y-3 text-13 text-ink">
        <ol className="list-decimal pl-5 space-y-1 text-inkMuted">
          <li>Open <a className="text-primary underline" href={console_} target="_blank" rel="noopener noreferrer">{console_.replace('https://', '')}</a> and choose the client whose Client ID is set on this server (a <strong>Self Client</strong> works).</li>
          <li>Go to <strong>Generate Code</strong>. Scope: <code className="font-mono text-ink">ZohoBooks.fullaccess.all</code> · Time duration: <strong>10 minutes</strong> · any description → <strong>Create</strong>.</li>
          <li>Copy the code (starts with <code className="font-mono">1000.</code>) and paste it below within 10 minutes. Each code works once.</li>
        </ol>
        <Field label="Data centre"><Select value={dc} onChange={setDc} options={DATA_CENTRES} /></Field>
        <Field label="Code from Zoho" error={error}>
          <TextInput value={code} onChange={setCode} placeholder="1000.xxxxxxxx.xxxxxxxx" className="font-mono" autoComplete="off" spellCheck={false} />
        </Field>
        <p className="text-12 text-inkMuted border-t border-border pt-3">
          Using a <strong>Server-based</strong> Zoho client with this server’s redirect URI registered?{' '}
          <button type="button" className="text-primary underline disabled:opacity-50" disabled={browserSignIn.loading} onClick={browserSignIn.start}>
            Sign in through Zoho instead
          </button>
        </p>
      </div>
    </Modal>
  );
}

/**
 * Connected, but Zoho lists no Books organisation for that Zoho login — the
 * account has never created Zoho Books, or its books belong to another login.
 * Says so plainly (instead of "choose an organisation" over an empty list)
 * and offers the two things that change it.
 */
export function NoZohoOrganisations() {
  const { status, can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const conn = status.connections.find((c) => c.status === 'connected');
  const booksUrl = (conn?.data_center ?? 'https://accounts.zoho.in').replace('accounts.', 'books.');
  const refresh = useMutation({
    mutationFn: async () => {
      await booksApi.refreshOrgs(conn!.id);
      await qc.invalidateQueries({ queryKey: statusKey });
      return (await booksApi.status()).organizations.length;
    },
    onSuccess: (n) => toast.push(n ? 'success' : 'error', n
      ? `${n} organisation${n === 1 ? '' : 's'} found — activate the ones to use in Books → Settings.`
      : 'Zoho still lists no Books organisation for this Zoho login.'),
    onError: (e) => toast.push('error', errorText(e)),
  });
  return (
    <Empty title="This Zoho account has no Zoho Books organisation">
      <span className="block">
        Zoho Books is connected, but the Zoho login you connected with doesn’t own or belong to any Zoho Books organisation in {booksUrl.replace('https://', '')}.
      </span>
      <span className="block mt-2">
        Create one in Zoho Books, or have the account that owns your books invite this login (Zoho Books → Settings → Users &amp; Roles). Then refresh.
      </span>
      {can.settings && conn ? (
        <span className="flex flex-wrap justify-center gap-2 mt-3">
          <a href={booksUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center h-9 px-4 rounded text-13 font-medium bg-surface text-ink border border-border hover:bg-canvas">
            Open Zoho Books
          </a>
          <Btn variant="primary" loading={refresh.isPending} onClick={() => refresh.mutate()}>Refresh organisations</Btn>
        </span>
      ) : null}
    </Empty>
  );
}
