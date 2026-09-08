import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/Button';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { getTool } from '@/modules/tools/registry';
import { TOOL_UI } from '@/modules/tools/tools';
import type { ToolOptions } from '@/modules/tools/tools/types';
import { useToolWorkspace } from '@/modules/tools/workspace/useToolWorkspace';
import { ToolWorkspaceLayout } from '@/modules/tools/workspace/ToolWorkspaceLayout';
import { FileDropzone } from '@/modules/tools/workspace/FileDropzone';
import { FileList } from '@/modules/tools/workspace/FileList';
import { ProcessingState } from '@/modules/tools/workspace/ProcessingState';
import { ResultPanel } from '@/modules/tools/workspace/ResultPanel';
import { ToolErrorState } from '@/modules/tools/workspace/ToolErrorState';
import { ComingSoonState } from '@/modules/tools/workspace/ComingSoonState';
import { Notice } from '@/modules/tools/workspace/fields';
import { NotFoundPage } from '@/pages/NotFound';

/**
 * /tools/:toolId — ONE page for all twelve tools (§6). The registry names
 * the tool, TOOL_UI supplies its options form and button label, the hook
 * runs the state machine. Compliance tools fall through to Coming soon.
 */
export function ToolWorkspacePage() {
  const { toolId } = useParams();
  const tool = getTool(toolId);
  if (!tool) return <NotFoundPage />;
  if (tool.status !== 'active' || !TOOL_UI[tool.id]) return <ComingSoonState tool={tool} />;
  return <ActiveWorkspace key={tool.id} toolId={tool.id} />;
}

function ActiveWorkspace({ toolId }: { toolId: string }) {
  const tool = getTool(toolId)!;
  const ui = TOOL_UI[tool.id];
  const { session } = useAuth();
  const permitted = can(session?.role.code, tool.permission, 'self');
  const ws = useToolWorkspace(tool);
  const [options, setOptions] = useState<ToolOptions>(() => ({ ...(ui.defaults ?? {}) }));
  useEffect(() => { setOptions({ ...(ui.defaults ?? {}) }); }, [ui]);
  const patch = (p: ToolOptions) => setOptions((o) => ({ ...o, ...p }));

  const readyFiles = ws.files.filter((f) => f.status === 'ready');
  const minFiles = ui.minFiles ?? 1;
  const validation = useMemo(() => (ui.validate ? ui.validate(options, ws.files) : null), [ui, options, ws.files]);
  const busy = ws.phase === 'processing';
  // After a failure the inputs are still there: fixing an option and pressing
  // the action again is a retry, so the button stays live in 'failed' too.
  const canRun = (ws.phase === 'ready' || ws.phase === 'failed') && readyFiles.length >= minFiles && !validation;
  const Options = ui.Options;

  if (!permitted) {
    return (
      <ToolWorkspaceLayout tool={tool}>
        <div className="border-l-2 border-amber pl-3">
          <div className="text-13 font-medium text-neutral-900">You do not have access to this tool</div>
          <p className="text-13 text-neutral-500 mt-1 max-w-[520px]">Ask an administrator to grant <code className="font-mono text-12">{tool.permission}</code> to your role.</p>
        </div>
      </ToolWorkspaceLayout>
    );
  }

  return (
    <ToolWorkspaceLayout tool={tool}>
      {ws.phase === 'success' && ws.run.output ? (
        <ResultPanel output={ws.run.output} warning={ws.run.warning} onReset={ws.reset}>
          {ui.ResultNote ? <ui.ResultNote output={ws.run.output} job={ws.run.job} /> : null}
        </ResultPanel>
      ) : (
        <div className="space-y-4">
          {ws.files.length === 0 || (tool.multiple && !busy) ? (
            <FileDropzone tool={tool} onFiles={ws.addFiles} disabled={busy} compact={tool.multiple && ws.files.length > 0} />
          ) : null}

          <FileList
            files={ws.files}
            onRemove={ws.removeFile}
            onMove={ws.moveFile}
            reorderable={Boolean(ui.reorderable)}
            disabled={busy}
            extra={ui.fileNote}
          />

          {Options && ws.files.length > 0 ? (
            <div className="pt-1">
              <Options files={ws.files} value={options} onChange={patch} disabled={busy} />
            </div>
          ) : null}

          {ws.phase === 'processing' ? (
            <ProcessingState label={ui.processingLabel} progress={ws.progress} />
          ) : ws.phase === 'failed' && ws.run.error ? (
            <ToolErrorState code={ws.run.error.code} message={ws.run.error.message} onRetry={ws.retry} onReset={ws.reset} />
          ) : null}

          {(ws.phase === 'ready' || ws.phase === 'failed') && validation ? <Notice tone="warn">{validation}</Notice> : null}

          {ws.files.length > 0 && ws.phase !== 'processing' ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="primary" onClick={() => ws.start(options)} disabled={!canRun} className="w-full sm:w-auto" data-testid="tool-run">
                {ui.actionLabel}
              </Button>
              {ws.phase === 'validating' ? <span className="text-13 text-neutral-500">Uploading…</span> : null}
              {ws.phase === 'invalid' ? <span className="text-13 text-neutral-500">Remove the file marked in red, then try again.</span> : null}
              {ws.phase === 'ready' && readyFiles.length < minFiles ? <span className="text-13 text-neutral-500">Add at least {minFiles} files.</span> : null}
            </div>
          ) : null}
        </div>
      )}
    </ToolWorkspaceLayout>
  );
}
