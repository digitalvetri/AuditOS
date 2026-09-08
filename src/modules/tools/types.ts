/**
 * Shapes emitted by server/src/modules/tools/serialize.ts. Kept in the
 * module (like Workstation's types.ts) so src/data/models.ts stays core-HR.
 */
export type DocumentKind = 'input' | 'output';
export type DocumentStatus = 'processing' | 'completed' | 'failed';
export type FileType = 'pdf' | 'excel' | 'word' | 'csv' | 'image' | 'text' | 'zip' | 'other';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ToolDocument {
  id: string;
  kind: DocumentKind;
  filename: string;
  mime_type: string;
  file_type: FileType;
  file_size: number;
  tool_id: string | null;
  tool_name: string | null;
  parent_document_id: string | null;
  status: DocumentStatus;
  error_message: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  created_by: { id: string; label: string };
  job_id: string | null;
}

export interface ToolJob {
  id: string;
  tool_id: string;
  tool_name: string;
  status: JobStatus;
  progress: number;
  error_message: string | null;
  input_document_id: string | null;
  output_document_id: string | null;
  meta: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  output?: ToolDocument | null;
}

export interface RegistryStatus {
  tools: {
    id: string;
    status: 'active' | 'coming_soon';
    permitted: boolean;
    implemented: boolean;
  }[];
}

export interface AuditEntry {
  id: string;
  action: string;
  status: 'success' | 'failed' | 'info';
  tool_id: string | null;
  document_id: string | null;
  actor: { id: string; label: string } | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface DocumentDetail {
  document: ToolDocument;
  source: ToolDocument | null;
  jobs: ToolJob[];
  audit: AuditEntry[];
  can_delete: boolean;
}

export interface DocumentsList {
  items: ToolDocument[];
  count: number;
  scope: 'organisation' | 'self';
  creators: { id: string; label: string }[];
}

export interface DocumentFilters {
  q?: string;
  kind?: DocumentKind | 'all';
  file_type?: '' | 'pdf' | 'excel' | 'word' | 'csv' | 'image' | 'text' | 'other';
  tool?: string;
  status?: '' | DocumentStatus;
  user_id?: string;
  from?: string;
  to?: string;
}

export interface SignedLink { url: string; expires_at: string }

export type PreviewResponse =
  | { kind: 'sheets'; sheets: { name: string; rows: string[][]; truncated: boolean }[] }
  | { kind: 'text'; text: string; truncated: boolean }
  | ({ kind: 'pdf' | 'image' } & SignedLink)
  | { kind: 'none' };

export interface PagesResponse {
  page_count: number;
  encrypted: boolean;
  thumbs: { page: number; url: string }[];
  truncated?: boolean;
}
