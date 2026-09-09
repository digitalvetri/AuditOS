import { ApiError } from '../../../lib/http.js'

/** 422 with a stable code — the API and the tests both key on `code`. */
export class BooksError extends ApiError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details)
  }
}

export class UnbalancedJournalError extends BooksError {
  constructor(debit: bigint, credit: bigint) {
    super('unbalanced_journal', `Journal is not balanced: debits ${debit} ≠ credits ${credit}.`, { debit: debit.toString(), credit: credit.toString() })
  }
}

/** Translate a database trigger abort into the same 422 the service layer raises. */
export function translateDbError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /books: ([^\n"']+)/.exec(msg)
  if (!m) return err
  const text = m[1].trim()
  const code = text.includes('not balanced') ? 'unbalanced_journal'
    : text.includes('append-only') ? 'audit_immutable'
    : text.includes('posted') ? 'journal_immutable'
    : text.includes('two lines') ? 'too_few_lines'
    : 'books_invariant'
  return new BooksError(code, `${text.charAt(0).toUpperCase()}${text.slice(1)}.`)
}
