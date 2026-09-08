const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })

/** '08 Sep 2026' — matches the client's fmtDate (§3 date_format). */
export function fmtDateIST(d: Date): string {
  return DATE.format(d)
}
