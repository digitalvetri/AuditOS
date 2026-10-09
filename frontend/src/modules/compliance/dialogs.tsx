/**
 * Calendar dialogs: mark filed, AGM date, import filed status from CSV.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { Modal } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { istToday } from '@/modules/dashboardV2/brief';
import {
  complianceApi, complianceKeys, rupeesToPaise, CSV_TEMPLATE_HEADER,
  type BulkResult, type ComplianceItem,
} from './api';
import { Chip, Labelled, day, downloadText, errorText, fieldClass, parseCsv, smallBtn } from './ui';

// ── Mark filed ───────────────────────────────────────────────────────────

/**
 * One item: filed on + acknowledgement no + late fee paid.
 * Several (bulk): filed on only — acknowledgement numbers differ per return.
 */
export function FiledDialog({ items, onClose }: { items: ComplianceItem[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const single = items.length === 1 ? items[0] : null;
  const [filedOn, setFiledOn] = useState(single?.filed_on ?? istToday());
  const [ack, setAck] = useState(single?.acknowledgement_no ?? '');
  const [fee, setFee] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      if (single) {
        await complianceApi.patchItem(single.id, {
          status: 'filed',
          filed_on: filedOn,
          acknowledgement_no: ack.trim() || null,
          ...(fee.trim() ? { late_fee_paid_paise: rupeesToPaise(fee) } : {}),
        });
        return null;
      }
      return complianceApi.bulk({ ids: items.map((i) => i.id), status: 'filed', filed_on: filedOn });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      const failed = r?.results?.filter((x) => !x.ok).length ?? 0;
      toast.push(failed ? 'error' : 'success',
        failed ? `${items.length - failed} marked filed, ${failed} failed` : single ? 'Marked filed' : `${items.length} marked filed`);
      onClose();
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  return (
    <Modal open title={single ? `Mark filed — ${single.form_name ?? single.form_code}` : `Mark ${items.length} items filed`}
      onClose={onClose} width="w-[460px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!filedOn || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Mark filed'}
        </Button>
      </>}>
      {single ? (
        <p className="text-13 text-neutral-600 mb-3">
          {single.client_name} · {single.period_label ?? single.period_key} · due {day(single.due_date)}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Filed on">
          <input type="date" className={fieldClass} value={filedOn} max={istToday()} onChange={(e) => setFiledOn(e.target.value)} />
        </Labelled>
        {single ? (
          <Labelled label="Acknowledgement / SRN / ARN">
            <input className={fieldClass} value={ack} onChange={(e) => setAck(e.target.value)} placeholder="e.g. 123456789012345" />
          </Labelled>
        ) : null}
        {single ? (
          <Labelled label="Late fee / interest paid (₹)" hint="Optional. Leave blank if none.">
            <input inputMode="decimal" className={fieldClass} value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
          </Labelled>
        ) : null}
      </div>
    </Modal>
  );
}

// ── AGM date ─────────────────────────────────────────────────────────────

export function AgmDialog({ item, onClose }: { item: ComplianceItem; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(item.anchor_date ?? '');
  const save = useMutation({
    mutationFn: () => complianceApi.patchItem(item.id, { anchor_date: date || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      toast.push('success', 'AGM date saved — due date recalculated');
      onClose();
    },
    onError: (e) => toast.push('error', errorText(e)),
  });
  return (
    <Modal open title={`AGM date — ${item.client_name ?? ''}`} onClose={onClose} width="w-[420px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <p className="text-13 text-neutral-600 mb-3">
        {item.form_name ?? item.form_code} for {item.period_label ?? item.period_key} is due a fixed number of days after the AGM.
        Until the date is entered the last permitted day (30 September) is assumed.
      </p>
      <Labelled label="AGM held / to be held on">
        <input type="date" className={fieldClass} value={date} onChange={(e) => setDate(e.target.value)} />
      </Labelled>
    </Modal>
  );
}

// ── Import filed status from CSV ─────────────────────────────────────────

const COLS = CSV_TEMPLATE_HEADER.split(',');
const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface PreviewRow { line: number; cells: string[]; problem: string | null }

export function ImportCsvDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [results, setResults] = useState<BulkResult[] | null>(null);

  const preview = useMemo<PreviewRow[]>(() => {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const body = rows[0].map((c) => c.trim().toLowerCase()).join(',') === CSV_TEMPLATE_HEADER ? rows.slice(1) : rows;
    return body.map((cells, i) => {
      const [client, form, period, , filedOn] = cells.map((c) => c.trim());
      let problem: string | null = null;
      if (cells.length < 5) problem = `Expected 5 columns, found ${cells.length}`;
      else if (!client || !form || !period) problem = 'Client code, form code and period are required';
      else if (!ISO.test(filedOn)) problem = 'Filed on must be YYYY-MM-DD';
      return { line: i + 1, cells: cells.map((c) => c.trim()), problem };
    });
  }, [text]);

  const valid = preview.filter((r) => !r.problem);

  const run = useMutation({
    mutationFn: () => complianceApi.importCsv([CSV_TEMPLATE_HEADER, ...valid.map((r) => r.cells.slice(0, 5).join(','))].join('\n')),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      const res = r?.results ?? [];
      setResults(res);
      const ok = res.filter((x) => x.ok).length;
      toast.push(ok === res.length ? 'success' : 'info', `${ok} of ${res.length} rows imported`);
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setResults(null);
    setText(await f.text());
  };

  const template = () => downloadText('compliance-filed-status-template.csv',
    `${CSV_TEMPLATE_HEADER}\r\nCLI-1001,GSTR9,2025-26,AA0912260012345,2026-12-20\r\n`);

  return (
    <Modal open title="Import filed status from CSV" onClose={onClose} width="w-[760px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>{results ? 'Close' : 'Cancel'}</Button>
        {!results ? (
          <Button size="sm" variant="primary" disabled={!valid.length || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Importing…' : `Import ${valid.length} row${valid.length === 1 ? '' : 's'}`}
          </Button>
        ) : null}
      </>}>
      <p className="text-13 text-neutral-600">
        One row per filed return: <code className="text-12">{CSV_TEMPLATE_HEADER}</code>. Client code is the
        client ID (CLI-1001), the period key matches the calendar (2025-26, 2025-26-Q1, 2026-04), dates are YYYY-MM-DD.
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" className={smallBtn} onClick={template}><Download size={14} /> Template</button>
        <label className={smallBtn + ' cursor-pointer'}>
          <Upload size={14} /> Choose CSV
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <span className="text-12 text-neutral-500">or paste below</span>
      </div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setResults(null); }} rows={4}
        className="mt-2 block w-full px-3 py-2 text-12 font-mono bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
        placeholder={CSV_TEMPLATE_HEADER} />

      {preview.length ? (
        <div className="mt-3 max-h-[320px] overflow-auto border border-neutral-200 rounded-lg">
          <table className="w-full text-12">
            <thead className="bg-neutral-50 text-neutral-500 text-left sticky top-0">
              <tr>
                <th className="px-3 py-2 font-normal">#</th>
                {COLS.map((c) => <th key={c} className="px-3 py-2 font-normal whitespace-nowrap">{c}</th>)}
                <th className="px-3 py-2 font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => {
                const res = results ? matchResult(results, r, valid.indexOf(r)) : null;
                return (
                  <tr key={i} className="border-t border-neutral-100">
                    <td className="px-3 py-2 text-neutral-400">{r.line}</td>
                    {COLS.map((_, ci) => <td key={ci} className="px-3 py-2 whitespace-nowrap">{r.cells[ci] ?? ''}</td>)}
                    <td className="px-3 py-2">
                      {r.problem ? <Chip tone="red" title={r.problem}>{r.problem}</Chip>
                        : res ? (res.ok ? <Chip tone="green">Imported</Chip> : <Chip tone="red" title={res.error ?? res.message ?? ''}>{res.error ?? res.message ?? 'Failed'}</Chip>)
                        : <Chip tone="grey">Ready</Chip>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
}

/** A server result for a preview row — by row number when given, else position. */
function matchResult(results: BulkResult[], r: PreviewRow, validIndex: number): BulkResult | null {
  if (validIndex < 0) return null;
  const byFields = results.find((x) => x.client_code && x.client_code === r.cells[0] && x.form_code === r.cells[1] && x.period_key === r.cells[2]);
  if (byFields) return byFields;
  const byRow = results.find((x) => x.row === validIndex + 1);
  return byRow ?? results[validIndex] ?? null;
}
