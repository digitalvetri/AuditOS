/**
 * Credential vault — reveal-on-click credential display (spec §5).
 *
 * Renders bare (no outer border/card) so it slots as a section inside the
 * parent handoff card. Client GST portal credentials are held by the firm:
 * masked by default, revealed on click, copied with feedback, auto
 * re-masks after 30 seconds. Audit-log notice sits inline below the rows.
 *
 * v1 caveats:
 *  - Values are hash-derived placeholders. Real encrypted backend vault
 *    lands with task #5.
 *  - Audit note is display-only. Real audit entries are written server-side
 *    when the backend endpoint ships.
 *  - Reveal is not tied to a permission grant yet. Real RBAC ("credential
 *    reveal" permission) is enforced server-side in the real flow.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, Eye, EyeOff, Info } from 'lucide-react';

const AUTO_REMASK_SECONDS = 30;

export interface VaultClient {
  id: string;
  name: string;
  gstin?: string | null;
}

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

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRevealed(false);
    setSecondsLeft(0);
  }, [client?.id]);

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
    <div aria-label="Client GST portal credentials">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-13 font-medium text-neutral-900">Credentials (post-login)</div>
        {revealed ? (
          <button
            type="button"
            onClick={mask}
            className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
          >
            <EyeOff size={12} strokeWidth={2} />
            Mask ({secondsLeft}s)
          </button>
        ) : (
          <button
            type="button"
            onClick={reveal}
            disabled={!client}
            title={client ? 'Reveal client credentials' : 'Pick a client first'}
            className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eye size={12} strokeWidth={2} />
            Reveal
          </button>
        )}
      </div>
      <div className="space-y-1">
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
      <div className="text-11 text-neutral-500 mt-2">
        Every reveal is audit-logged (operator, timestamp, service). Auto re-masks after {AUTO_REMASK_SECONDS}s.
      </div>
    </div>
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
    <div className="flex items-center gap-3">
      <div className="text-11 text-neutral-500 w-20 shrink-0">{label}</div>
      <div
        className={
          'flex-1 text-13 font-mono truncate ' +
          (revealed ? 'text-neutral-900' : 'text-neutral-500 tracking-widest')
        }
      >
        {displayed}
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!revealed}
        title={revealed ? 'Copy to clipboard' : 'Reveal first to copy'}
        className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {copied ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function maskAllButLastTwo(v: string): string {
  if (v.length <= 2) return '•'.repeat(v.length);
  return '•'.repeat(v.length - 2) + v.slice(-2);
}

export function CredentialsNotNeededNote() {
  return (
    <div className="flex items-start gap-2 text-12 text-neutral-500">
      <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
      <span>This destination is pre-login — no client credentials required.</span>
    </div>
  );
}
