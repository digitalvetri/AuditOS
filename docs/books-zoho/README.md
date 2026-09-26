# Books — Zoho Books integration (Tools → Books)

Books is an Audit OS interface over the firm's Zoho Books organisations. Zoho Books
holds every accounting record. Audit OS stores only the OAuth grant, which Zoho
organisations are active (and which client each belongs to), and a cached dashboard
snapshot. It replaces the earlier native double-entry "Books" ledger, which has been removed.

It is separate from **Workstation → Services → Bookkeeping**, the service-management
workflow. A Bookkeeping client links to Books through the Zoho organisation mapped to it.

```
Browser ──► /api/books/* (Audit OS, session + RBAC) ──► modules/books/client.ts ──► Zoho Books API v3
                                                        (tokens, refresh, retry,
                                                         rate limit, error mapping)
```

The browser never sees a Zoho client secret, access token or refresh token.

## Setup

1. In the Zoho API console for your data centre (e.g. https://api-console.zoho.in), create a client.
   Either type works:
   - **Self Client** (simplest). No redirect URI is involved. You connect by pasting a one-time
     code (see *Connect with a code* below).
   - **Server-based Application**. Set its redirect URI to exactly `https://<api-host>/api/books/callback`
     (locally `http://localhost:<api-port>/api/books/callback`). Any difference, including a trailing
     slash, `https` vs `http` or another port, makes Zoho answer "Invalid Redirect Uri".
2. Set these variables on the API server (see `server/.env.example`):

   | Variable | Purpose |
   |---|---|
   | `ZBOOKS_CLIENT_ID`, `ZBOOKS_CLIENT_SECRET` | App credentials (required) |
   | `ZBOOKS_REDIRECT_URI` | Server-based clients only: must equal the redirect registered in Zoho |
   | `ZBOOKS_ENCRYPTION_KEY` | base64 32-byte AES-256-GCM key for tokens at rest (required in production; falls back to `ZPAY_ENCRYPTION_KEY`) |
   | `ZBOOKS_ACCOUNTS_BASE` | Where consent starts (default `https://accounts.zoho.in`) |
   | `ZBOOKS_SCOPES` | Default `ZohoBooks.fullaccess.all` |
   | `WEB_ORIGIN` | First origin is where the callback sends the browser back to |

3. Create the Books tables. On a database that still has the old native Books ledger, drop its
   tables first (`npm --prefix server run db:drop-legacy-books`: the 23 old `Books*` tables only, a
   no-op once they are gone), then `npm --prefix server run prisma:push`. Docker's `migrate` service
   does both automatically. Then open
   **Tools → Books → Settings → Connect Zoho Books**.

## Connect with a code (Self Client)

**Tools → Books → Settings → Connect Zoho Books** opens a dialog that needs no browser redirect,
so it works whatever redirect URI the Zoho client has, including none.

1. In the Zoho API console, open the client and go to **Generate Code**. Scope
   `ZohoBooks.fullaccess.all`, time duration 10 minutes, any description, then **Create**.
2. Paste the code (it starts with `1000.`) into the dialog, pick the data centre and click **Connect**.
   A code works once and only for a few minutes.
3. `POST /api/books/connect/code` exchanges the code on that data centre. No `redirect_uri` is sent,
   since a Self Client code is issued without one. It stores the encrypted tokens and lists the
   organisations, reusing an unfinished connection rather than adding rows. From here it is the
   same as the browser flow (step 3 below).

Errors are shown in plain words: `invalid_code` (wrong, used or expired code), `invalid_client`
(wrong data centre or client credentials), `invalid_redirect_uri`. The dialog also links to the
browser sign-in for Server-based clients.

If the connection succeeds but Zoho lists no organisation, the Zoho login used has no Zoho Books
organisation in that data centre. Books and Settings say so and offer **Open Zoho Books** and
**Refresh organisations**. Create an organisation, or have the owner invite this login, then refresh.

## Flow


1. **Connect.** `POST /api/books/connect` creates a connection row in `consent_pending` and returns
   Zoho's authorize URL. `state` is a JWT signed with `JWT_SECRET`, expires after 10 minutes, and carries a purpose tag.
2. **Callback.** `GET /api/books/callback` is public, because Zoho redirects the browser here.
   - It verifies `state` and exchanges the code on the user's data centre, taken from the
     `accounts-server` parameter and only accepted when it is a Zoho host.
   - It encrypts both tokens and stores `api_domain`.
   - It lists `GET /organizations`, then redirects to `/books/settings?zoho=connected`.
3. **Activate.** Settings lists the organisations. The user activates the ones to use and can map
   each to one Audit OS client. The database enforces one organisation per client.
4. **Use.** Every data call is `/api/books/o/:orgRef/...`. `orgRef` is the Audit OS row id, looked up
   together with the firm, so one firm can never address another firm's organisation.
5. **Tokens.** An access token is refreshed a minute before it expires, with only one refresh in flight per
   connection. A 401 from Zoho forces one refresh and a retry. If the refresh is refused
   (`invalid_code` / `invalid_grant`), the connection is marked `revoked` and the UI asks the user to reconnect.
6. **Disconnect.** Audit OS revokes the refresh token at Zoho (best effort), deletes both tokens locally
   and deactivates that connection's organisations. Nothing in Zoho is deleted.

## What is supported

The resources are defined in `server/src/modules/books/entities.ts`, and the routes are generic over that table.

| Section | Zoho resource | Operations |
|---|---|---|
| Customers / Vendors | `contacts` (`contact_type`) | list/search/filter/sort, create, edit, view, active/inactive, delete |
| Items | `items` | CRUD, active/inactive |
| Estimates | `estimates` | CRUD, mark sent/accepted/declined, email, PDF, create invoice from it |
| Sales Orders | `salesorders` | CRUD, open, void, email, PDF, create invoice from it |
| Invoices | `invoices` | CRUD, mark sent, revert to draft, void, email, PDF, record payment |
| Purchase Orders | `purchaseorders` | CRUD, open, billed, cancel, email, PDF, create bill from it |
| Bills | `bills` | CRUD, open, void, record payment |
| Expenses | `expenses` | CRUD, receipt upload |
| Payments | `customerpayments`, `vendorpayments` | CRUD, applied to invoices / bills |
| Credit Notes | `creditnotes` | CRUD, open, void, apply to invoices, refund, email, PDF |
| Debit Notes | `vendorcredits` | CRUD, open, void, apply to bills, refund |
| Banking | `bankaccounts`, `banktransactions` | accounts CRUD, transactions list/add |
| Reconciliation | `banktransactions/uncategorized/*` | match suggestions, match, categorize, exclude/restore, unmatch, uncategorize |
| Taxes | `settings/taxes` | list, create, edit, delete |

"Create invoice from estimate / sales order" and "create bill from PO" open a new document
prefilled with the source's party and lines. The source number goes into the reference field.

## Limitations (deliberately not faked)

- **Financial statements.** P&L, Balance Sheet, Cash Flow and the Tax / GST summary show
  *"This report is not available through the current Zoho Books API integration."*
- **Computed reports.** These reports are summed in Audit OS from Zoho records and labelled that way; they are not official Zoho reports:
  - receivables and payables ageing
  - customer and vendor balances
  - sales by customer, purchases by vendor
  - expenses by category
- **Statement reconciliation.** Closing a statement period is not exposed by the API, so it is done in Zoho Books.
  Audit OS covers matching and categorizing.
- **Contact persons.** These are set when a contact is created. Afterwards they are edited in Zoho, because updating
  them through the API could drop people added in Zoho.
- **Inventory tracking.** This is not managed here; item stock is shown only when Zoho returns it.
- **Dashboard and report caps.** They read up to 1,000 documents per list, most recent first. When a cap is hit,
  the result is flagged `truncated` and the UI says so.

## Sync, caching and limits

- The dashboard is a **snapshot** computed at sync time from about 12 list calls, stored in
  `BooksZohoOrganization.snapshotJson`.
  - **Sync now** refreshes it.
  - Opening the dashboard also refreshes it when it is older than the organisation's auto-refresh interval (Settings; default 60 minutes; 0 = manual only).
  - Only one sync runs per organisation at a time; a claim older than 5 minutes can be taken over.
  - Every run is recorded in `BooksSyncLog`.
- **Lists** are read live from Zoho with server-side paging, search, filter and sort. GET responses are cached for 30 seconds
  per connection and organisation, and any write to that organisation clears its cache.
- **Rate limit.** A budget of 90 calls per minute per organisation keeps under Zoho's limit of 100. GET requests are retried on network errors, 5xx
  responses and short 429s. Writes are never retried.

## Permissions

Books requires **organisation** scope, because a Zoho organisation has no per-user membership.

| Code | Allows |
|---|---|
| `books.access` | View Books |
| `books.manage` | Create and edit records; Sync now |
| `books.accountant` | Delete and void, payments, banking and reconciliation actions |
| `books.settings` | Connect/disconnect Zoho, activate and map organisations, taxes |
| `books.reports` | Reports |

The employee role's old `self` grants were removed. Employees previously saw only the sets of books they were
assigned to, and that assignment no longer exists.

## Audit log

The following are written to the platform `AuditLog`:
- connect and disconnect
- organisation activation and mapping
- every create, update, delete and status action, with the Zoho id and document number
- sync start, completion and failure

## Tests

`server/src/modules/books/__tests__/books.test.ts` runs the real app against a fake Zoho. It covers:
- OAuth start, callback, invalid state, refused code and untrusted data centre
- token refresh, revoked grants, retry after a 401, and disconnect
- RBAC and duplicate client mapping
- list, create, validation errors, actions, PDF, id validation and outage mapping
- sync success, failure, retry and concurrency
- computed and unavailable reports
