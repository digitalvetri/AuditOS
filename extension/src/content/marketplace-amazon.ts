/**
 * Runs on sellercentral.amazon.in only. Pins a bottom-right "AuditOS →
 * Repotic" FAB (floating action button) that shows the current Ecommerce
 * scope and offers to upload a tax report the seller just downloaded.
 *
 * We deliberately do NOT scrape the Amazon DOM. Seller Central's layout
 * changes constantly; a selector-based "intercept the download link" would
 * silently break every month and sellers would never know. Instead:
 *
 *   1. Seller downloads the MTR / GST report through Amazon's own UI
 *      (one place, their session, their MFA — not our problem).
 *   2. They click the AuditOS FAB and pick the file they just saved.
 *   3. We POST it straight to /api/repotic/ecommerce/uploads with
 *      client_id / gstin / period / marketplace=amazon / report_kind
 *      taken from the stored scope + a tiny dropdown.
 *
 * This also means the SAME file can go to AuditOS from any marketplace
 * portal with the same code (Flipkart, Meesho, Myntra get a two-line
 * manifest entry plus a per-site FAB that reuses this module).
 *
 * Scope is read from chrome.storage.local, populated by the AuditOS
 * Ecommerce page via crm-bridge. If no scope is set, the FAB links back
 * to AuditOS to pick one — never asks the seller to type a GSTIN.
 */
import { extensionAlive, send } from './messaging';
import type { EcommerceScope } from '../types';

const FAB_ID = 'auditos-repotic-fab';
const PANEL_ID = 'auditos-repotic-panel';

/** Amazon's own report kinds we currently seed adapters for. In Phase 1 of
 *  the extension we only offer B2C/B2B MTR; the fingerprint on the backend
 *  rejects anything that doesn't match an adapter, which is the correct
 *  failure mode (vs. silently sending the wrong format). */
const AMAZON_REPORT_KINDS = [
  { key: 'mtr_b2c', label: 'MTR B2C' },
  { key: 'mtr_b2b', label: 'MTR B2B' },
] as const;

interface ScopeState { ok: true; scope: EcommerceScope | null }

/** chrome.storage.local write from the service worker — refresh the FAB
 *  immediately when the AuditOS page changes scope in another tab. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ecommerceScope) return;
  renderFab(changes.ecommerceScope.newValue as EcommerceScope | null);
});

async function getScope(): Promise<EcommerceScope | null> {
  if (!extensionAlive()) return null;
  const r = await send<ScopeState>({ type: 'AUDITOS_GET_ECOMMERCE_SCOPE' });
  return r?.scope ?? null;
}

function renderFab(scope: EcommerceScope | null) {
  let fab = document.getElementById(FAB_ID);
  if (!fab) {
    fab = document.createElement('div');
    fab.id = FAB_ID;
    Object.assign(fab.style, {
      position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px',
      padding: '10px 14px', borderRadius: '10px', background: '#1b3a6f', color: '#fff',
      font: '13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
      boxShadow: '0 10px 24px -8px rgba(15,23,42,.45)', cursor: 'pointer', userSelect: 'none',
      maxWidth: '280px',
    });
    fab.setAttribute('role', 'button');
    fab.setAttribute('aria-label', 'Open AuditOS Repotic upload panel');
    document.documentElement.appendChild(fab);
    fab.addEventListener('click', () => void togglePanel());
  }
  if (scope) {
    fab.innerHTML =
      `<div style="opacity:.7;font-size:11px;letter-spacing:.06em;margin-bottom:2px">AUDITOS · REPOTIC</div>` +
      `<div style="font-weight:600">${escapeHtml(scope.clientName)}</div>` +
      `<div style="opacity:.8;font-size:11px;margin-top:2px">${escapeHtml(scope.gstin)} · ${escapeHtml(scope.period)} · tap to upload</div>`;
  } else {
    fab.innerHTML =
      `<div style="opacity:.7;font-size:11px;letter-spacing:.06em;margin-bottom:2px">AUDITOS · REPOTIC</div>` +
      `<div style="font-weight:600">No scope set</div>` +
      `<div style="opacity:.8;font-size:11px;margin-top:2px">Pick a client · GSTIN · period in AuditOS first</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

async function togglePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) { existing.remove(); return; }
  const scope = await getScope();
  if (!scope) {
    openScopeHelper();
    return;
  }
  openUploadPanel(scope);
}

/** No scope — show a tiny card linking back to AuditOS. We don't ask the
 *  seller to type a GSTIN here on purpose: the scope must come from the
 *  firm's own system of record (so no sibling client with the same GSTIN
 *  gets uploaded by accident). */
function openScopeHelper() {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, basePanelStyles());
  panel.innerHTML =
    `<div style="font-weight:600;margin-bottom:6px">Pick a scope in AuditOS first</div>` +
    `<div style="font-size:12px;color:#555;margin-bottom:10px">Open AuditOS → Audit automation → Ecommerce GSTR-1, pick client / GSTIN / period, then come back to this tab.</div>` +
    `<div style="display:flex;gap:8px"><button id="auditos-open-crm" style="${btnStyles(true)}">Open AuditOS</button>` +
    `<button id="auditos-panel-close" style="${btnStyles(false)}">Close</button></div>`;
  document.documentElement.appendChild(panel);
  const openBtn = panel.querySelector<HTMLButtonElement>('#auditos-open-crm');
  if (openBtn) openBtn.onclick = () => window.open('http://localhost:8080/audit-automation/ecommerce', '_blank');
  const closeBtn = panel.querySelector<HTMLButtonElement>('#auditos-panel-close');
  if (closeBtn) closeBtn.onclick = () => panel.remove();
}

function openUploadPanel(scope: EcommerceScope) {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, basePanelStyles());
  panel.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px">Send to AuditOS Repotic</div>` +
    `<div style="font-size:12px;color:#555;margin-bottom:10px">${escapeHtml(scope.clientName)} · ${escapeHtml(scope.gstin)} · ${escapeHtml(scope.period)}</div>` +
    `<label style="display:block;font-size:11px;color:#555;margin-bottom:4px">Report kind` +
      `<select id="auditos-report-kind" style="${selectStyles()}">${AMAZON_REPORT_KINDS.map((k) => `<option value="${k.key}">${k.label}</option>`).join('')}</select>` +
    `</label>` +
    `<label style="display:block;font-size:11px;color:#555;margin-bottom:4px">File` +
      `<input id="auditos-file" type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" style="display:block;width:100%;margin-top:4px;font-size:12px" />` +
    `</label>` +
    `<div id="auditos-status" style="min-height:16px;font-size:12px;color:#555;margin:8px 0"></div>` +
    `<div style="display:flex;gap:8px"><button id="auditos-upload" style="${btnStyles(true)}" disabled>Upload</button>` +
    `<button id="auditos-panel-close" style="${btnStyles(false)}">Close</button></div>`;
  document.documentElement.appendChild(panel);

  const fileInput = panel.querySelector<HTMLInputElement>('#auditos-file');
  const uploadBtn = panel.querySelector<HTMLButtonElement>('#auditos-upload');
  const statusEl = panel.querySelector<HTMLDivElement>('#auditos-status');
  const kindSel = panel.querySelector<HTMLSelectElement>('#auditos-report-kind');
  const closeBtn = panel.querySelector<HTMLButtonElement>('#auditos-panel-close');
  if (!fileInput || !uploadBtn || !statusEl || !kindSel || !closeBtn) return;
  closeBtn.onclick = () => panel.remove();
  fileInput.onchange = () => { uploadBtn.disabled = !fileInput.files?.length; };
  uploadBtn.onclick = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    statusEl.textContent = 'Uploading…';
    try {
      const result = await uploadToAuditos(scope, kindSel.value, file);
      if (result.ok) {
        const r = (result.body as { data?: { detect_status?: string; adapter_version?: number; parse?: { rows: number } } } | undefined)?.data;
        statusEl.innerHTML = r?.detect_status === 'matched'
          ? `<span style="color:#0f766e">✓ Uploaded · adapter v${r.adapter_version} · ${r.parse?.rows ?? 0} rows parsed</span>`
          : r?.detect_status === 'drifted'
          ? `<span style="color:#b45309">Uploaded with warnings — header drifted from adapter v${r.adapter_version}</span>`
          : `<span style="color:#b91c1c">Header did not match any adapter. Add the adapter in AuditOS first.</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:#b91c1c">${escapeHtml(result.error ?? 'Upload failed')}</span>`;
      }
    } catch (e) {
      statusEl.innerHTML = `<span style="color:#b91c1c">${escapeHtml((e as Error).message)}</span>`;
    } finally {
      uploadBtn.disabled = false;
    }
  };
}

function basePanelStyles(): Partial<CSSStyleDeclaration> {
  return {
    position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '76px',
    padding: '14px', borderRadius: '10px', background: '#fff', color: '#111',
    font: '13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
    boxShadow: '0 10px 24px -8px rgba(15,23,42,.45)', width: '280px',
    border: '1px solid #e5e7eb',
  };
}
function btnStyles(primary: boolean): string {
  return primary
    ? 'flex:1;height:30px;background:#1b3a6f;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;'
    : 'flex:1;height:30px;background:#f3f4f6;color:#111;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer;';
}
function selectStyles(): string {
  return 'display:block;width:100%;height:28px;margin-top:4px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;padding:0 6px;';
}

/** POST the file to AuditOS, using the browser's own stored session for
 *  the CRM origin recorded on the scope. The content script runs on
 *  amazon.in, so a browser fetch to http://localhost:8080 is cross-origin
 *  — Chrome allows it because the manifest grants host_permissions for
 *  the AuditOS origin, and the server-side CORS middleware trusts the
 *  CRM origin for its API. `credentials: 'include'` attaches the
 *  AuditOS session cookie (we never see or store it). */
async function uploadToAuditos(scope: EcommerceScope, reportKind: string, file: File): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('client_id', scope.clientId);
  fd.append('gstin', scope.gstin);
  fd.append('period', scope.period);
  fd.append('marketplace', 'amazon');
  fd.append('report_kind', reportKind);
  try {
    const resp = await fetch(`${scope.crmOrigin}/api/repotic/ecommerce/uploads`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = (body as { error?: { message?: string } } | undefined)?.error?.message
        ?? `Upload failed (${resp.status})`;
      return { ok: false, error: err };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Boot — read the stored scope and paint the FAB. onChanged keeps it live
// as the AuditOS page updates it. We don't poll.
void (async () => {
  const scope = await getScope();
  renderFab(scope);
})();
