/**
 * Credential vault v1 — reveal-on-click UI (spec §5).
 *
 * Client GST portal credentials are held by the firm. This component
 * models the intended UX: masked by default, revealed on click, copied
 * with feedback, remasked automatically after 30 seconds, with an
 * "audit-logged" notice on every reveal.
 *
 * v1 caveats:
 *  - Values are hard-coded placeholders. A real client picker + the
 *    encrypted backend vault land with task #5.
 *  - The audit note is display-only. Actual audit log entries are written
 *    server-side when the backend endpoint ships.
 *  - The reveal is not tied to a permission grant yet. RBAC ("credential
 *    reveal" permission) is enforced server-side in the real flow.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ClipboardCopy,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';

const AUTO_REMASK_SECONDS = 30;

export interface VaultClient {
  id: string;
  name: string;
  gstin?: string | null;
}

/**
 * Placeholder credential generator. Real vault entries land with task #5;
 * until then, values are derived from the client id so different clients
 * appear to have different credentials.
 */
function placeholderCredentials(client: VaultClient | null): { username: string; password: string } {
  if (!client) {
    return { username: 'client_username', password: 'client_password_placeholder' };
  }
  const slug = client.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  const yr = new Date().getFullYear();
  return {
    username: `${slug || 'client'}_${yr}`,
    password: `${(slug || 'client').slice(0, 8) || 'client'}!GstPortal#${yr}`,
  };
}

export function CredentialVault({ client }: { client: VaultClient | null }) {
  const [revealed, setRevealed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);
  const creds = placeholderCredentials(client);

  // Remask whenever the client changes so a stale reveal doesn’t leak.
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRevealed(false);
    setSecondsLeft(0);
  }, [client?.id]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  function reveal() {
    setRevealed(true);
    setSecondsLeft(AUTO_REMASK_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSecondsLeft((n) => {
        if (n <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setRevealed(false);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  }

  function mask() {
    if (timerRef.current) clearInterval(timerRef.current);
    setRevealed(false);
    setSecondsLeft(0);
  }

  async function copy(key: 'username' | 'password') {
    const value = key === 'username' ? creds.username : creds.password;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard denied — non-fatal.
    }
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  return (
    <section
      className="bg-white border border-neutral-200 rounded-lg overflow-hidden"
      aria-label="Client GST portal credentials"
    >
      <header className="bg-neutral-50 border-b border-neutral-200 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <KeyRound size={16} strokeWidth={1.75} className="text-neutral-500" />
          <div>
            <div className="text-13 font-semibold text-neutral-900">Client GST portal credentials</div>
            <div className="text-11 text-neutral-500">
              {client
                ? `${client.name}${client.gstin ? ' · GSTIN ' + client.gstin : ''}`
                : 'Select a client above to see credentials'}
            </div>
          </div>
        </div>
        {revealed ? (
          <button
            type="button"
            onClick={mask}
            className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-white"
          >
            <EyeOff size={14} strokeWidth={2} />
            Mask ({secondsLeft}s)
          </button>
        ) : (
          <button
            type="button"
            onClick={reveal}
            disabled={!client}
            title={client ? 'Reveal client credentials' : 'Pick a client first'}
            className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eye size={14} strokeWidth={2} />
            Reveal
          </button>
        )}
      </header>

      <div className="divide-y divide-neutral-100">
        <CredentialRow
          label="Username"
          value={creds.username}
          revealed={revealed}
          copied={copied === 'username'}
          onCopy={() => copy('username')}
        />
        <CredentialRow
          label="Password"
          value={creds.password}
          revealed={revealed}
          copied={copied === 'password'}
          onCopy={() => copy('password')}
          isSecret
        />
      </div>

      <footer className="bg-neutral-50 border-t border-neutral-200 px-4 py-2 flex items-start gap-2 text-11 text-neutral-500">
        <ShieldCheck size={14} strokeWidth={1.75} className="text-neutral-400 mt-0.5 shrink-0" />
        <span>
          Every reveal is audit-logged with the operator, timestamp and service. Auto re-masks
          after {AUTO_REMASK_SECONDS}s. Values shown here are placeholders — the encrypted
          vault + RBAC land with the backend engine.
        </span>
      </footer>
    </section>
  );
}

function CredentialRow({
  label, value, revealed, copied, onCopy, isSecret,
}: {
  label: string;
  value: string;
  revealed: boolean;
  copied: boolean;
  onCopy: () => void;
  isSecret?: boolean;
}) {
  const displayed = revealed
    ? value
    : isSecret
      ? '•'.repeat(12)
      : maskAllButLastTwo(value);
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
        <div
          className={
            'mt-1 text-14 font-mono truncate ' +
            (revealed ? 'text-neutral-900' : 'text-neutral-500 tracking-widest')
          }
        >
          {displayed}
        </div>
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!revealed}
        title={revealed ? 'Copy to clipboard' : 'Reveal first to copy'}
        className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {copied ? <Check size={14} strokeWidth={2.5} /> : <ClipboardCopy size={14} strokeWidth={2} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function maskAllButLastTwo(v: string): string {
  if (v.length <= 2) return '•'.repeat(v.length);
  return '•'.repeat(v.length - 2) + v.slice(-2);
}

/** Small inline note the handoff page can render even when the vault is not
 *  shown — e.g., for pre-login services that don’t need credentials. */
export function CredentialsNotNeededNote() {
  return (
    <div className="flex items-start gap-2 text-12 text-neutral-500">
      <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
      <span>
        This destination is pre-login — no client credentials required. The vault is skipped.
      </span>
    </div>
  );
}
