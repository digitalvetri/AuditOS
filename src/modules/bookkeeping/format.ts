/** `awaiting_documents` → `Awaiting documents`. Used for every status/category label. */
export const human = (v: string | null | undefined): string =>
  !v ? '—' : v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Options for a <Select> built from a server-provided vocabulary. */
export const opts = (values: readonly string[] = []) =>
  values.map((v) => ({ value: v, label: human(v) }));

export const PRIORITY_TONE: Record<string, string> = {
  critical: 'text-red-700',
  high: 'text-amber-700',
  medium: 'text-neutral-700',
  low: 'text-neutral-500',
};
