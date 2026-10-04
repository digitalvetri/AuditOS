/**
 * /integrations/ai-provider — per-firm LLM API key configuration.
 *
 * Today only Groq is supported (used by the GST Notices reply drafter).
 * Anthropic and OpenAI are placeholders for later — same shape, same storage,
 * different backend call.
 *
 * Permission: integrations.access@organisation.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, CheckCircle2, XCircle, KeyRound, Trash2, ExternalLink } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Card, Field, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { api } from '@/services/api';

type Provider = 'groq';

interface AiConfigRow {
  provider: Provider;
  has_key: boolean;
  key_fingerprint: string;
  model: string | null;
  default_model: string | null;
  active: boolean;
  updated_at: string;
}

const aiApi = {
  list: () => api.get<AiConfigRow[]>('/api/integrations/ai'),
  save: (body: { provider: Provider; api_key: string; model?: string }) =>
    api.put<AiConfigRow>('/api/integrations/ai', body),
  test: (body: { provider: Provider; api_key: string; model?: string }) =>
    api.post<{ ok: true; model: string }>('/api/integrations/ai/test', body),
  remove: (provider: Provider) => api.delete<void>(`/api/integrations/ai/${provider}`),
};

export function AiProviderIntegrationPage() {
  const { session } = useAuth();
  const allowed = can(session?.role.code, 'integrations.access', 'organisation');
  if (!allowed) {
    return (
      <div className="w-full max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-4 md:p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          Integrations are Finance / MD only.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          Ask a partner or finance admin to configure the AI provider.
        </p>
      </div>
    );
  }
  return (
    <div className="m-page">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Integrations</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">AI provider</h1>
        <p className="text-13 text-neutral-500 mt-1 max-w-[640px]">
          The LLM used by the GST Notices → Reply drafter. Add your firm's own Groq
          key here; it is encrypted at rest and never returned by the API after
          saving. Until a key is saved the server falls back to the stack-level
          GROQ_API_KEY env var (if set).
        </p>
      </header>
      <div className="mt-6 space-y-4">
        <GroqSection />
      </div>
    </div>
  );
}

function GroqSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['integrations', 'ai'], queryFn: () => aiApi.list() });
  const existing = q.data?.find((r) => r.provider === 'groq') ?? null;

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const save = useMutation({
    mutationFn: () => aiApi.save({ provider: 'groq', api_key: apiKey, model: model || undefined }),
    onSuccess: () => {
      toast.push('success', 'Groq key saved. The Notices drafter will now use your firm\'s key.');
      setApiKey('');
      qc.invalidateQueries({ queryKey: ['integrations', 'ai'] });
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Save failed.'),
  });

  const test = useMutation({
    mutationFn: () => aiApi.test({ provider: 'groq', api_key: apiKey, model: model || undefined }),
    onSuccess: (r) => toast.push('success', `Key works — provider responded with model ${r.model}.`),
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Test failed.'),
  });

  const remove = useMutation({
    mutationFn: () => aiApi.remove('groq'),
    onSuccess: () => {
      toast.push('success', 'Groq key removed. The server will fall back to the env var (if set).');
      qc.invalidateQueries({ queryKey: ['integrations', 'ai'] });
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Remove failed.'),
  });

  return (
    <Card title="Groq">
      <div className="p-5 space-y-4">
        {existing ? (
          <div className="flex items-center gap-3 p-3 border border-green/40 bg-green/5 rounded text-13">
            <CheckCircle2 size={16} className="text-green" />
            <div className="flex-1">
              <div className="font-medium text-neutral-900">
                Key configured — fingerprint {existing.key_fingerprint}
              </div>
              <div className="text-12 text-neutral-500">
                Model: <span className="font-mono">{existing.model || existing.default_model}</span>
                <span className="mx-2">·</span>
                Updated {new Date(existing.updated_at).toLocaleString('en-IN')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { if (window.confirm('Remove the Groq key for this organisation?')) remove.mutate(); }}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1 h-8 px-2 text-12 text-neutral-500 hover:text-red disabled:opacity-60"
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-3 border border-amber/40 bg-amber/5 rounded text-13">
            <XCircle size={16} className="text-amber" />
            <div className="flex-1">
              <div className="font-medium text-neutral-900">No firm-level key configured.</div>
              <div className="text-12 text-neutral-500">
                The Notices drafter will use the stack-level GROQ_API_KEY env var if set — otherwise it will fail with "LLM not configured".
              </div>
            </div>
          </div>
        )}

        <Field
          label="Groq API key"
          hint={
            <span className="inline-flex items-center gap-1">
              Create one at{' '}
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                console.groq.com/keys <ExternalLink size={11} />
              </a>
              . Starts with <span className="font-mono">gsk_</span>…
            </span>
          }
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            placeholder={existing ? 'Enter a new key to replace the existing one' : 'gsk_...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>

        <Field
          label="Model override (optional)"
          hint={<>Leave blank to use the default — <span className="font-mono">{existing?.default_model ?? 'openai/gpt-oss-120b'}</span>.</>}
        >
          <input
            className={inputClass}
            placeholder="openai/gpt-oss-120b"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>

        <div className="flex items-center gap-2 pt-2">
          <Button onClick={() => save.mutate()} disabled={!apiKey.trim() || save.isPending}>
            {save.isPending ? (
              <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Saving…</span>
            ) : (
              <span className="inline-flex items-center gap-2"><KeyRound size={14} /> Save key</span>
            )}
          </Button>
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={!apiKey.trim() || test.isPending}
            className="h-9 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
          >
            {test.isPending ? 'Testing…' : 'Test key'}
          </button>
          <div className="text-12 text-neutral-500">
            Test calls Groq with the key you just typed (not the saved one).
          </div>
        </div>
      </div>
    </Card>
  );
}
