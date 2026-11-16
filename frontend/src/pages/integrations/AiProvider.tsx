/**
 * /integrations/ai-provider — per-firm LLM API keys.
 *
 * Providers: Claude (Anthropic), OpenAI, Google Gemini and Groq. One card
 * each; one provider is current per firm and is what every AI feature uses
 * (GST Notices reply drafter today). The firm's first saved key becomes
 * current; "Use this provider" switches. Keys are encrypted at rest and
 * never returned by the API after saving.
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
import { confirmAction } from '@/components/ConfirmDialog';

type Provider = 'anthropic' | 'openai' | 'gemini' | 'groq';

interface ProviderRow {
  provider: Provider;
  label: string;
  key_url: string;
  default_model: string;
  configured: boolean;
  key_fingerprint: string | null;
  model: string | null;
  is_current: boolean;
  updated_at: string | null;
}

interface AiOverview {
  current_provider: Provider | null;
  env_fallback: boolean;
  providers: ProviderRow[];
}

const aiApi = {
  overview: () => api.get<AiOverview>('/api/integrations/ai'),
  save: (body: { provider: Provider; api_key: string; model?: string }) =>
    api.put<AiOverview>('/api/integrations/ai', body),
  test: (body: { provider: Provider; api_key?: string; model?: string }) =>
    api.post<{ ok: true; provider: Provider; model: string }>('/api/integrations/ai/test', body),
  activate: (provider: Provider) => api.post<AiOverview>(`/api/integrations/ai/${provider}/activate`),
  remove: (provider: Provider) => api.delete<void>(`/api/integrations/ai/${provider}`),
};

/** Shown under the key input: where the key comes from and what it looks like. */
const KEY_HINT: Record<Provider, { placeholder: string; prefix: string | null }> = {
  anthropic: { placeholder: 'sk-ant-...', prefix: 'sk-ant-' },
  openai: { placeholder: 'sk-...', prefix: 'sk-' },
  gemini: { placeholder: 'AIza...', prefix: 'AIza' },
  groq: { placeholder: 'gsk_...', prefix: 'gsk_' },
};

const AI_QUERY_KEY = ['integrations', 'ai'] as const;

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
  return <AiProviderPage />;
}

function AiProviderPage() {
  const q = useQuery({ queryKey: AI_QUERY_KEY, queryFn: () => aiApi.overview() });
  const data = q.data;
  const current = data?.providers.find((p) => p.is_current) ?? null;

  return (
    <div className="m-page">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Integrations</div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900 mt-1">AI provider</h1>
        <p className="text-13 text-neutral-500 mt-1 max-w-[640px]">
          The active provider is used by every AI feature — today the GST Notices reply drafter.
          Add your firm's own key for any provider below; keys are encrypted at rest and never
          shown again after saving. The first key you save becomes active; use
          "Use this provider" to switch.
        </p>
      </header>

      <div className="mt-6 space-y-4">
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-13 text-neutral-500">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : q.isError || !data ? (
          <div className="text-13 text-danger">Could not load the AI provider settings.</div>
        ) : (
          <>
            {current ? (
              <div className="flex items-center gap-3 p-3 border border-success/40 bg-success/5 rounded text-13">
                <CheckCircle2 size={16} className="text-success" />
                <div className="flex-1">
                  <span className="font-medium text-neutral-900">Active: {current.label}</span>
                  <span className="text-neutral-500">
                    {' '}· model <span className="font-mono">{current.model || current.default_model}</span>
                    {data.env_fallback ? ' · using the server-wide GROQ_API_KEY (no firm key saved yet)' : ''}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 border border-amber/40 bg-amber/5 rounded text-13">
                <XCircle size={16} className="text-amber" />
                <div className="flex-1">
                  <div className="font-medium text-neutral-900">No AI provider configured.</div>
                  <div className="text-12 text-neutral-500">
                    AI features will fail with "LLM not configured" until you save a key below.
                  </div>
                </div>
              </div>
            )}
            {data.providers.map((p) => (
              <ProviderCard key={p.provider} row={p} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ row }: { row: ProviderRow }) {
  if (row.is_current) {
    return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-success/10 text-success">Active</span>;
  }
  if (row.configured) {
    return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-neutral-100 text-neutral-700">Configured</span>;
  }
  return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-neutral-100 text-neutral-500">Not configured</span>;
}

function ProviderCard({ row }: { row: ProviderRow }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const hint = KEY_HINT[row.provider];
  const keyHost = row.key_url.replace(/^https:\/\//, '').replace(/\/$/, '');
  const refresh = () => qc.invalidateQueries({ queryKey: AI_QUERY_KEY });
  const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

  const save = useMutation({
    mutationFn: () => aiApi.save({ provider: row.provider, api_key: apiKey, model: model.trim() || undefined }),
    onSuccess: (r) => {
      const active = r.current_provider === row.provider;
      toast.push('success', active ? `${row.label} key saved and active.` : `${row.label} key saved.`);
      setApiKey('');
      setModel('');
      refresh();
    },
    onError: (e) => toast.push('error', errMsg(e, 'Save failed.')),
  });

  // With a typed key, test that; otherwise test the saved one.
  const test = useMutation({
    mutationFn: () => aiApi.test({ provider: row.provider, api_key: apiKey.trim() || undefined, model: model.trim() || undefined }),
    onSuccess: (r) => toast.push('success', `Key works — ${row.label} answered with model ${r.model}.`),
    onError: (e) => toast.push('error', errMsg(e, 'Test failed.')),
  });

  const activate = useMutation({
    mutationFn: () => aiApi.activate(row.provider),
    onSuccess: () => {
      toast.push('success', `AI features now use ${row.label}.`);
      refresh();
    },
    onError: (e) => toast.push('error', errMsg(e, 'Could not switch provider.')),
  });

  const remove = useMutation({
    mutationFn: () => aiApi.remove(row.provider),
    onSuccess: () => {
      toast.push('success', `${row.label} key removed.`);
      refresh();
    },
    onError: (e) => toast.push('error', errMsg(e, 'Remove failed.')),
  });

  const canTest = !!apiKey.trim() || row.configured;

  return (
    <Card title={row.label} right={<StatusPill row={row} />}>
      <div className="p-5 space-y-4">
        {row.configured ? (
          <div className="flex flex-wrap items-center gap-3 p-3 border border-neutral-200 rounded text-13">
            <KeyRound size={16} className="text-neutral-500" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-neutral-900">
                Key saved — fingerprint <span className="font-mono">{row.key_fingerprint}</span>
              </div>
              <div className="text-12 text-neutral-500">
                Model: <span className="font-mono">{row.model || row.default_model}</span>
                {row.updated_at ? (
                  <>
                    <span className="mx-2">·</span>
                    Updated {new Date(row.updated_at).toLocaleString('en-IN')}
                  </>
                ) : null}
              </div>
            </div>
            {!row.is_current ? (
              <button
                type="button"
                onClick={() => activate.mutate()}
                disabled={activate.isPending}
                className="h-8 px-3 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
              >
                {activate.isPending ? 'Switching…' : 'Use this provider'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                const extra = row.is_current ? ' AI features will switch to your next saved provider, if any.' : '';
                if (await confirmAction(`Remove the ${row.label} key for this organisation?${extra}`)) remove.mutate();
              }}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1 h-8 px-2 text-12 text-neutral-500 hover:text-danger disabled:opacity-60"
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
        ) : null}

        <Field
          label={`${row.label} API key`}
          hint={
            <span className="inline-flex flex-wrap items-center gap-1">
              Create one at{' '}
              <a
                href={row.key_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                {keyHost} <ExternalLink size={11} />
              </a>
              {hint.prefix ? <>. Starts with <span className="font-mono">{hint.prefix}</span>…</> : '.'}
            </span>
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className={inputClass}
            placeholder={row.configured ? 'Enter a new key to replace the saved one' : hint.placeholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>

        <Field
          label="Model (optional)"
          hint={<>Leave blank to use the default — <span className="font-mono">{row.default_model}</span>.</>}
        >
          <input
            className={inputClass}
            placeholder={row.model || row.default_model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-2">
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
            disabled={!canTest || test.isPending}
            className="h-9 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
          >
            {test.isPending ? 'Testing…' : 'Test key'}
          </button>
          <div className="text-12 text-neutral-500">
            {apiKey.trim() ? 'Tests the key you just typed.' : row.configured ? 'Tests the saved key.' : 'Type a key to test it.'}
          </div>
        </div>
      </div>
    </Card>
  );
}
