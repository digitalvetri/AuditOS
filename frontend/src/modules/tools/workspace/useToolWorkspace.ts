import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '@/services/api';
import { toolsApi } from '../api';
import type { ToolDefinition } from '../registry';
import type { ToolDocument, ToolJob } from '../types';
import { extensionOf } from '../format';

/**
 * The one state machine every tool workspace runs on (§6):
 *
 *   idle → validating → ready → processing → success
 *                     ↘ invalid           ↘ failed
 *
 * Files are validated in the browser (type, size, count) and uploaded as
 * soon as they are added, so by the time the user clicks the action button
 * the server already holds them and has told us what they are (page count,
 * CSV detection, …). The action creates a job and polls it to completion.
 */
export type Phase = 'idle' | 'validating' | 'invalid' | 'ready' | 'processing' | 'success' | 'failed';

export interface LocalFile {
  key: string;
  file: File;
  status: 'validating' | 'uploading' | 'ready' | 'invalid';
  progress: number;
  error?: string;
  doc?: ToolDocument;
}

export interface RunState {
  job: ToolJob | null;
  output: ToolDocument | null;
  error: { code: string; message: string } | null;
  warning: string | null;
}

let keySeq = 0;

export function validateFile(tool: ToolDefinition, file: File): string | null {
  const ext = extensionOf(file.name);
  const typeOk = tool.extensions.includes(ext === 'jpeg' ? 'jpg' : ext) || tool.extensions.includes(ext) || (file.type && tool.accepts.includes(file.type) && file.type !== 'text/plain');
  if (!typeOk) {
    const label = [...new Set(tool.extensions.map((e) => (e === 'jpeg' ? 'jpg' : e)))].map((e) => e.toUpperCase()).join(', ');
    return `This file type isn't supported. Upload a ${label} file.`;
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > tool.maxFileSizeMB * 1024 * 1024) return `File is larger than the ${tool.maxFileSizeMB} MB limit.`;
  return null;
}

export function useToolWorkspace(tool: ToolDefinition) {
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [run, setRun] = useState<RunState>({ job: null, output: null, error: null, warning: null });
  const [running, setRunning] = useState(false);
  const pollRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    abortRef.current?.abort();
  }, []);

  // Changing tools resets everything.
  useEffect(() => {
    setFiles([]);
    setRun({ job: null, output: null, error: null, warning: null });
    setRunning(false);
  }, [tool.id]);

  const patch = useCallback((key: string, p: Partial<LocalFile>) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...p } : f)));
  }, []);

  const addFiles = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    const accepted = tool.multiple ? incoming : incoming.slice(0, 1);
    const entries: LocalFile[] = accepted.map((file) => {
      const error = validateFile(tool, file);
      return { key: `f${++keySeq}`, file, status: error ? 'invalid' : 'validating', progress: 0, error: error ?? undefined };
    });
    setRun({ job: null, output: null, error: null, warning: null });
    setFiles((prev) => (tool.multiple ? [...prev, ...entries] : entries));
    // Upload each valid file on its own request so progress is per file.
    for (const entry of entries) {
      if (entry.status === 'invalid') continue;
      patch(entry.key, { status: 'uploading' });
      const controller = new AbortController();
      abortRef.current = controller;
      toolsApi.upload(tool.id, [entry.file], (pct) => patch(entry.key, { progress: pct }), controller.signal)
        .then((res) => patch(entry.key, { status: 'ready', progress: 100, doc: res.items[0] }))
        .catch((err: ApiError) => patch(entry.key, { status: 'invalid', error: err.message || 'Upload failed. Please try again.' }));
    }
  }, [tool, patch]);

  const removeFile = useCallback((key: string) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
    setRun({ job: null, output: null, error: null, warning: null });
  }, []);

  const moveFile = useCallback((from: number, to: number) => {
    setFiles((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    setFiles([]);
    setRun({ job: null, output: null, error: null, warning: null });
    setRunning(false);
  }, []);

  /** Keep the inputs, clear the result — "Try again" after a failure. */
  const retry = useCallback(() => {
    setRun({ job: null, output: null, error: null, warning: null });
    setRunning(false);
  }, []);

  const start = useCallback(async (options: Record<string, unknown>) => {
    const ready = files.filter((f) => f.status === 'ready' && f.doc);
    if (!ready.length) return;
    setRunning(true);
    setRun({ job: null, output: null, error: null, warning: null });
    try {
      const job = await toolsApi.createJob(tool.id, ready.map((f) => f.doc!.id), options);
      setRun((r) => ({ ...r, job }));
      const poll = async () => {
        try {
          const j = await toolsApi.job(job.id);
          if (j.status === 'completed' && j.output) {
            setRun({ job: j, output: j.output, error: null, warning: (j.meta.warning as string | null) ?? (j.output.meta.warning as string | null) ?? null });
            setRunning(false);
            return;
          }
          if (j.status === 'failed') {
            // A failed job still has a document record (status: failed) — that is
            // history, not an output. The workspace shows the error, not a file.
            setRun({ job: j, output: null, error: { code: String(j.meta.code ?? 'failed'), message: j.error_message ?? 'Conversion failed. Please try again.' }, warning: null });
            setRunning(false);
            return;
          }
          setRun((r) => ({ ...r, job: j }));
          pollRef.current = window.setTimeout(poll, 800);
        } catch (err) {
          setRun((r) => ({ ...r, error: { code: 'network', message: (err as Error).message || 'Lost contact with the server. Please try again.' } }));
          setRunning(false);
        }
      };
      pollRef.current = window.setTimeout(poll, 500);
    } catch (err) {
      const e = err as ApiError;
      setRun({ job: null, output: null, error: { code: e.code ?? 'failed', message: e.message || 'Conversion failed. Please try again.' }, warning: null });
      setRunning(false);
    }
  }, [files, tool.id]);

  const phase = useMemo<Phase>(() => {
    if (run.error) return 'failed';
    if (run.output) return 'success';
    if (running) return 'processing';
    if (files.length === 0) return 'idle';
    if (files.some((f) => f.status === 'validating' || f.status === 'uploading')) return 'validating';
    if (files.some((f) => f.status === 'invalid')) return 'invalid';
    return 'ready';
  }, [files, run, running]);

  const progress = run.job?.progress ?? 0;

  return { files, phase, run, progress, addFiles, removeFile, moveFile, start, reset, retry };
}

export type ToolWorkspaceState = ReturnType<typeof useToolWorkspace>;
