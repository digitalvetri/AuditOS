/**
 * Non-blocking "also on another client" warnings from client create / edit.
 * The server names only clients the user may see and counts the rest
 * (`*_hidden`), so this never names a client the user is not assigned to.
 */
type Dupes = Array<{ client_code: string; company_name: string }>;
interface DuplicateFields {
  phone_duplicates?: Dupes;
  phone_duplicates_hidden?: number;
  gstin_duplicates?: Dupes;
  gstin_duplicates_hidden?: number;
}

function line(what: string, dupes: Dupes = [], hidden = 0): string | null {
  if (!dupes.length && !hidden) return null;
  const named = dupes.map((d) => `${d.client_code} ${d.company_name}`);
  if (hidden) named.push(`${hidden} other client${hidden === 1 ? '' : 's'} you are not assigned to`);
  return `${what} is also on: ${named.join(', ')}`;
}

export function duplicateWarnings(resp: unknown): string[] {
  const d = (resp ?? {}) as DuplicateFields;
  return [
    line('This phone number', d.phone_duplicates, d.phone_duplicates_hidden),
    line('This GSTIN', d.gstin_duplicates, d.gstin_duplicates_hidden),
  ].filter((x): x is string => x !== null);
}
