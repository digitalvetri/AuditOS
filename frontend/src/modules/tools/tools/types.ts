import type { ComponentType } from 'react';
import type { LocalFile } from '../workspace/useToolWorkspace';
import type { ToolDocument, ToolJob } from '../types';

/**
 * What a tool contributes on top of the shared workspace (§6): an options
 * form (if any), validation of those options, its button label, and an
 * optional block under the result. Nothing else is per-tool.
 */
export type ToolOptions = Record<string, unknown>;

export interface OptionsProps {
  files: LocalFile[];
  value: ToolOptions;
  onChange: (patch: ToolOptions) => void;
  disabled: boolean;
}

export interface ToolUI {
  actionLabel: string;
  processingLabel: string;
  defaults?: ToolOptions;
  /** Fewer ready files than this keeps the action disabled. */
  minFiles?: number;
  reorderable?: boolean;
  Options?: ComponentType<OptionsProps>;
  /** Return a message to block the run, null to allow it. */
  validate?: (value: ToolOptions, files: LocalFile[]) => string | null;
  /** Per-file fact shown in the file list once uploaded. */
  fileNote?: (f: LocalFile) => string | null;
  ResultNote?: ComponentType<{ output: ToolDocument; job: ToolJob | null }>;
}
