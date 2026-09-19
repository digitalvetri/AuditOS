# ZOHO PAYMENTS INTEGRATION
## Firm collections — two accounts, external invoicing

**Supersedes** `ZOHO-PAYMENTS-INTEGRATION.md`, which assumed client-side accounts
and Zoho Books. This is the firm's own money, two Zoho Payments accounts, invoices
raised elsewhere.

Verified against Zoho's official API documentation, September 2026.

---

## 1. What this actually is now

| | Previous assumption | Reality |
|---|---|---|
| Whose money | The firm's clients' | **The firm's own collections** |
| Accounts | One per client | **Two, firm-level** |
| Invoices | Zoho Books | **A separate system** |
| Matching | Automatic via Books | **Ours to build** |
| Permission scope | Per client | **Internal finance** |

Three consequences worth stating plainly.

**This is internal finance data, not client data.** It belongs behind a finance
permission, visible to partners and finance admin — not on every client record for
every executive to browse.

**Nothing auto-matches.** Zoho Books is what normally marks an invoice paid when
money arrives. Without it, a payment lands in Zoho and your invoice sits open in
another system, and nobody connects them. **Closing that gap is the entire value of
this integration** — not the dashboard.

**The two accounts are not a cosmetic split.** They are almost certainly two
billing entities with separate GST positions, and money in one has different tax
consequences from money in the other.

---

## 2. Answer this before writing any code

**Are the two accounts under one Zoho login, or two separate logins?**

It determines the whole auth model, and it takes two minutes to check.

| | One Zoho organisation | Two organisations |
|---|---|---|
| OAuth | **One** consent, one refresh token | **Two** consents, two refresh tokens |
| `account_id` | Two values against one token | One value per token |
| Schema | One connection, two accounts | Two connections, one account each |

To check: log into `payments.zoho.in` and see whether both accounts appear under
the same login, or whether switching requires signing out.

**Build the schema so it handles both** — a connection table and an account table,
one-to-many. If it turns out to be one login, you have one connection row with two
accounts. If two, you have two of each. No rework either way.

---

## 3. The two accounts

```
  ┌─────────────────────────────┐        ┌─────────────────────────────┐
  │   GST ACCOUNT               │        │   NON-GST ACCOUNT           │
  │                             │        │                             │
  │   Registered entity         │        │   Unregistered entity       │
  │   GSTIN on invoices         │        │   No GSTIN                  │
  │   Tax invoice series        │        │   Bill of supply series     │
  │   Collections feed GSTR-1   │        │   Outside GST returns       │
  │                             │        │                             │
  │   Clients who need input    │        │   Clients who don't         │
  │   credit                    │        │                             │
  └─────────────────────────────┘        └─────────────────────────────┘
```

**Each client is billed from one account, not both.** That mapping belongs on the
client record, set once at onboarding, and it drives which payment link gets
generated and which invoice series is used.

A client billed from the wrong entity is a real problem — a GST-registered client
who receives a non-GST bill cannot claim input credit, and will ask for it to be
redone.

**GST note.** Tax liability arises on the **invoice**, not on collection. So these
payment records are not themselves a GST input. What they are useful for is
reconciliation: collections against invoices raised, per entity, which is what
surfaces unbilled work and unreported revenue.

**One item that gets missed:** Zoho's per-transaction fee is a cost the firm incurs,
and GST on that fee is claimable input credit for the registered entity. Capture the
fee per payment if the API exposes it, and check whether it does before promising
it. [VERIFY]

---

## 4. Invoice matching — the real problem

Without Zoho Books, the only link between a payment and an invoice is the reference
you put there yourself.

### 4.1 The process decision, made before the first link

**Generate one payment link per invoice, and put the invoice number in the link's
reference or description field.** It comes back in the API response, and matching
becomes exact.

Skip this, and you are matching on amount and date — which breaks the first time
two invoices are for the same amount, which for a CA firm's standard fees is
constantly.

This is a discipline decision, not a code one. It has to be agreed with whoever
raises the invoices, and it has to hold for every link.

### 4.2 Three-tier matching

```
  1  EXACT      reference field contains a known invoice number
                → auto-matched, no human involved

  2  PROBABLE   amount matches an open invoice for a client billed from
                this account, within a date window
                → proposed, requires confirmation

  3  UNMATCHED  neither
                → review queue
```

**Tier 2 is a proposal, never an automatic match.** Show it, let a human confirm.
And the review queue for tier 3 is the screen the finance person will actually use
every week.

### 4.3 What matching gives you

Once payments are matched to invoices, four things fall out that the firm does not
currently have in one place:

- Receivables that are actually current, not as of the last manual reconciliation
- Which clients are habitually late
- Collections by entity, for the GST reconciliation
- Unbilled collections — money received with no invoice behind it, which is either
  an advance or a bookkeeping gap

---

## 5. Data model

```
zpay_connection
  id · zoho_org_label                  "GST entity" / "Non-GST entity" / "Both"
  refresh_token_encrypted
  access_token_encrypted · access_token_expires_at
  scopes_granted[]
  status  not_connected | consent_pending | connected | revoked | expired | error
  connected_at · connected_by · last_error_code · last_error_at

zpay_account
  id · connection_id                   ← one connection may hold two accounts
  account_id                           ← Zoho's, required on every API call
  label                                "GST" | "Non-GST"
  is_gst_registered BOOLEAN
  legal_entity_name · gstin (nullable)
  invoice_series_prefix                ← for reference matching
  is_active
  last_sync_at · last_sync_status

zpay_payment
  account_id_fk · zoho_payment_id      ← UNIQUE together
  amount_paise INTEGER
  fee_paise INTEGER (nullable)         ← if the API exposes it
  currency · status · payment_mode
  customer_name · customer_email
  reference_number                     ← THE matching key
  description
  mandate_id (nullable)
  paid_at · created_at_zoho
  raw JSONB                            ← immutable
  synced_at

  -- matching
  matched_invoice_ref (nullable)
  matched_client_id (nullable)
  match_type  exact | probable | manual | unmatched
  match_confirmed_by · match_confirmed_at

zpay_refund
  account_id_fk · zoho_refund_id       ← UNIQUE together
  zoho_payment_id · amount_paise · status · reason
  refunded_at · raw JSONB · synced_at

zpay_sync_run
  account_id_fk · started_at · finished_at
  window_from · window_to
  payments_fetched · refunds_fetched
  status · error_code · error_detail · api_calls_made
```

**`client.billing_account_id`** goes on the existing client record — a nullable FK
to `zpay_account`. One line, and it drives everything downstream.

Money is **integer paise**. Never float. `raw` is immutable.

> **Naming note (Prisma).** In `server/prisma/schema.prisma` the models are the
> PascalCase equivalents — `ZpayConnection`, `ZpayAccount`, `ZpayPayment`,
> `ZpayRefund`, `ZpaySyncRun` — because the rest of the repo carries no `@@map`
> directives. The `zpay_` prose in this doc names the intent (namespace + easy
> grep); the `Zpay` model prefix preserves it.

---

## 6. Screens

### 6.1 Firm collections — Accounts section, finance permission

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Accounts › Collections                                September 2026 ◂  |  ▸ │
│                                                                              │
│  [ All ]  [ GST entity ]  [ Non-GST entity ]                                 │
│  ──────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│    COLLECTED           MATCHED            UNMATCHED         REFUNDED         │
│    ₹8,42,500           ₹7,18,000          ₹1,24,500         ₹12,000          │
│    184 payments        156                28                3                │
│                                                                              │
│  ──────────────────────────────────────────────────────────────────────────  │
│    GST entity          ₹6,10,000    128 payments    synced 8 min ago         │
│    Non-GST entity      ₹2,32,500     56 payments    synced 8 min ago         │
│                                                                              │
│ ▍  28 payments need matching                          [ Review queue ▸ ]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

The flagged row is the point of the screen. Everything above it is reference.

### 6.2 Matching queue — the screen that gets used

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Accounts › Collections › Matching                          28 unmatched      │
│  [ Unmatched 28 ]  [ Proposed 11 ]  [ Matched 156 ]                          │
├──────────────────────────────────────────────────────────────────────────────┤
│    DATE     AMOUNT      PAYER                  REF              ACCOUNT      │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▍  14 Sep   ₹25,000     Kovai Textiles         —                GST          │
│    Probable: INV/2026/0412 · ₹25,000 · raised 09 Sep   [Confirm] [Other ▸]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▍  12 Sep   ₹18,000     R. Muthukumar          UPI/4471         Non-GST      │
│    No open invoice matches this amount              [Link manually ▸]        │
├──────────────────────────────────────────────────────────────────────────────┤
│    11 Sep   ₹42,000     Anand & Sons           INV/2026/0398    GST          │
│    Matched automatically on reference                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Client record — a small slice

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BILLING                                              Billed from: GST entity│
│  ──────────────────────────────────────────────────────────────────────────  │
│  Paid this FY        ₹1,84,000        Last payment  14 Sep 2026 · ₹25,000    │
│  Outstanding         ₹42,000          Oldest        INV/2026/0361 · 62 days  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Behind the finance permission. Not visible to every executive.

---

## 7. Build prompt

```
Build the Zoho Payments integration for FIRM COLLECTIONS across TWO
accounts. Read-only against Zoho. Matching logic is ours.

This is the FIRM's own money, not client data. It sits in the Accounts
section behind a finance permission — NOT on every client record for
every user.

Follow existing adapter and card patterns. Reuse existing components and
design tokens. New tables prefixed zpay_. Modify no existing table except
to add one nullable column to clients (see §3).

═══════════════════════════════════════════════════════════════
0. FIRST — determine the account topology
═══════════════════════════════════════════════════════════════

The firm has TWO Zoho Payments accounts: one GST-registered entity, one
non-GST entity.

Establish whether these sit under ONE Zoho login or TWO, and report it
before building auth. Check at payments.zoho.in — do both accounts appear
under one login, or does switching require signing out?

  One login  → one OAuth connection, two account_id values
  Two logins → two OAuth connections, one account_id each

BUILD THE SCHEMA TO HANDLE BOTH: zpay_connection one-to-many
zpay_account. One login gives one connection row with two accounts. Two
logins gives two of each. No rework either way.

═══════════════════════════════════════════════════════════════
1. OAUTH — India data centre
═══════════════════════════════════════════════════════════════

  API base      https://payments.zoho.in/api/v1/
  OAuth host    https://accounts.zoho.in/
  Console       https://accounts.zoho.in/developerconsole

  USE .in — NOT accounts.zoho.com. Zoho's docs default to .com examples
  and an Indian account fails against that host in a way the error does
  not explain.

  SCOPES — exactly these two, nothing more:
      ZohoPay.payments.READ
      ZohoPay.refunds.READ

  CRITICAL: the authorization code is valid for ONE MINUTE. The callback
  exchanges it for tokens IMMEDIATELY and SYNCHRONOUSLY. No queue, no
  background job, no intermediate screen.

  Access token: 1 hour. Refresh PROACTIVELY before expiry, never
  reactively on a 401.
  Refresh token: encrypted at rest. This is the credential that matters.

  API calls:
    Header: Authorization: Zoho-oauthtoken <access_token>
    Header ONLY — it cannot be a request parameter.
    account_id is a required query parameter, per account.

  Do NOT generate API keys or signing keys. Those are for the checkout
  widget. Not applicable.

  Since this is firm-level, the CONNECT action lives in Settings under a
  finance permission — not on a client record.

═══════════════════════════════════════════════════════════════
2. SCHEMA
═══════════════════════════════════════════════════════════════

  Per the architecture doc §5. Key points:

  zpay_account carries: label (GST | Non-GST), is_gst_registered,
  legal_entity_name, gstin (nullable), invoice_series_prefix.

  zpay_payment carries reference_number — THE matching key — plus
  matched_invoice_ref, matched_client_id, match_type
  (exact | probable | manual | unmatched), match_confirmed_by,
  match_confirmed_at.

  Capture fee_paise per payment IF the Zoho API exposes it. Check the
  actual response and report whether it does. Do not invent the field.

  ADD to the existing client table:
    billing_account_id  nullable FK → zpay_account
  One client is billed from ONE account. This drives which invoice series
  applies and which account a payment is expected in.

  Money is INTEGER PAISE everywhere. Never float, never decimal-as-float.
  Check the unit Zoho actually returns and normalise ONCE at the adapter
  boundary.

  raw JSONB is IMMUTABLE — exactly what Zoho returned, never updated.

  UNIQUE (account_id_fk, zoho_payment_id) so re-syncing is idempotent.

═══════════════════════════════════════════════════════════════
3. SYNC
═══════════════════════════════════════════════════════════════

  Scheduled daily, PER ACCOUNT. Two accounts, two sync runs, two
  zpay_sync_run rows.

  Window: last_sync_at minus 3 days → now. The overlap catches late
  settlement and status changes; idempotent upserts make it free.

    GET /payments?account_id={id}   with date filters
    GET /refunds?account_id={id}

  NEVER call Zoho on a page render. Cards read local tables only.

  FAILURES:
    access token expired  → refresh, retry once
    refresh token invalid → status = revoked, surface in Settings,
                            STOP RETRYING
    rate limited          → exponential backoff, record in sync_run
    network / 5xx         → backoff, then failed with error recorded
    partial page          → status = partial with counts. NEVER silently
                            truncate

  One account failing must NOT stop the other from syncing.

═══════════════════════════════════════════════════════════════
4. MATCHING — the actual value of this build
═══════════════════════════════════════════════════════════════

  Three tiers, evaluated in order:

  1 EXACT
    reference_number or description contains a recognisable invoice
    number matching the account's invoice_series_prefix.
    → match_type = exact. Auto-matched. No human step.

  2 PROBABLE
    amount matches an open invoice for a client whose
    billing_account_id is this account, within a configurable date
    window (default 15 days).
    → match_type = probable. PROPOSED ONLY.
    NEVER auto-confirm a probable match. Show the candidate invoice and
    require explicit confirmation.

  3 UNMATCHED
    neither → review queue.

  MATCHING QUEUE SCREEN
    Tabs: Unmatched · Proposed · Matched, each with a count.
    Columns: date, amount, payer, reference, account.
    Under a proposed row: the candidate invoice with its number, amount
    and raised date, plus Confirm and Choose other.
    Under an unmatched row: Link manually, opening an invoice search
    scoped to clients billed from that account.
    Manual link records match_type = manual with who and when.

  Unmatching is permitted and recomputes immediately.

  IMPORTANT: matching reads invoices from the firm's EXISTING invoicing
  system. If there is no API into it, build the match against an imported
  invoice list (CSV/XLSX) and state clearly that this is the interim
  mechanism. Do NOT build a second invoicing system.

═══════════════════════════════════════════════════════════════
5. SCREENS
═══════════════════════════════════════════════════════════════

  ACCOUNTS › COLLECTIONS  (finance permission)
    Period selector. Tabs: All · GST entity · Non-GST entity.
    Collected · Matched · Unmatched · Refunded, each with amount and
    count. Per-account breakdown with last-synced time.
    A flagged row for unmatched count linking to the queue.

  ACCOUNTS › COLLECTIONS › MATCHING
    As specified in section 4.

  CLIENT RECORD › BILLING  (finance permission)
    Billed-from account · paid this FY · last payment · outstanding ·
    oldest open invoice with age.
    Hidden entirely from users without the finance permission — not
    greyed, hidden.

  SETTINGS › INTEGRATIONS › ZOHO PAYMENTS
    Connection status per account, last sync, reconnect action.
    States: not_connected · consent_pending · connected · revoked ·
    expired · error. All five must render.

═══════════════════════════════════════════════════════════════
6. SECURITY
═══════════════════════════════════════════════════════════════

  client_secret, refresh tokens, access tokens: encrypted at rest.
  NEVER in source control, logs, job records or error payloads. Assert
  with a test.

  Collections data requires a finance permission. Viewing a client's
  billing slice is that same permission, not "view client".

  Connect, disconnect, reconnect and every manual match write to the
  existing audit log with actor and timestamp.

═══════════════════════════════════════════════════════════════
7. ACCEPTANCE — paste evidence for each
═══════════════════════════════════════════════════════════════

  □ Report the account topology finding from section 0 before auth work
  □ grep for "accounts.zoho.com" → zero matches
  □ Consent URL requests exactly two scopes, both READ — paste it
  □ Authorization code exchanged synchronously in the callback;
    demonstrate a delayed exchange failing as expected
  □ Refresh fires before expiry, not on 401 — show the scheduler
  □ Both accounts sync independently; one failing does not stop the other
  □ Re-running a sync over the same window creates zero duplicates
  □ All amounts integer paise — grep for parseFloat / Number() on amount
    fields returns nothing
  □ Report whether the Zoho API exposes a per-transaction fee, with the
    actual response body as evidence
  □ An exact reference match auto-matches with no human step
  □ A probable match is PROPOSED and cannot be confirmed without an
    explicit action — demonstrate the API refusing auto-confirm
  □ Manual link records match_type = manual with actor and timestamp
  □ A client billed from the GST account never proposes a match against
    a Non-GST payment
  □ Cards render from local tables — network tab shows zero calls to
    zoho.in on page load
  □ A user without the finance permission cannot see Collections or the
    client billing slice — 403 from the API, not just hidden UI
  □ All five connection states render in Settings
  □ grep: no secret or token in source, logs or job records
  □ Zero new components, zero new design tokens
```

---

## 8. Sequencing

| Step | Work | Gate |
|---|---|---|
| 0 | Determine account topology | One login or two, answered |
| 1 | Schema + connection state machine | A connection moves through every state |
| 2 | OAuth + both accounts connected | Both sync independently |
| 3 | Sync job, idempotent | Re-run creates no duplicates |
| 4 | Collections card | Both entity tabs render with real data |
| 5 | **Matching engine + queue** | A real month matches at >80% on exact |
| 6 | Client billing slice | Behind the finance permission |

**Four to five days.** Step 5 is where the value is and where most of the effort
should go.

---

## 9. Settle before step 1

**The reference discipline.** One payment link per invoice, invoice number in the
reference field. Agree it with whoever raises the invoices before the first link
goes out. Without it, tier-1 matching never fires and every payment lands in the
review queue — which makes this integration worse than the spreadsheet it replaces.

**How the invoicing system exposes invoices.** An API, a database, or a CSV export.
If it is a CSV export, that is fine as the interim mechanism, but say so on screen
so nobody assumes the outstanding figure is live.

**The client-to-account mapping.** Every client needs `billing_account_id` set.
Do it as a one-off data exercise before go-live, not lazily as payments arrive —
an unmapped client breaks tier-2 matching silently.

**Whether the API returns the transaction fee.** Step 2 of the acceptance list asks
for the actual response body. GST on that fee is claimable input credit for the
registered entity, so it is worth capturing if it is there.
