# Workstation → Clients: organizations, billing in the organization's name, services: design

Approved in conversation on 2026-11-18. The user chose every recommended option.

## Problem
- **Organizations are hidden.** The "Organizations" chip on the Clients page appears only when at least one organization already exists. The only way to create one is a radio button inside Add Client. There is also no easy way to put a client under an organization.
- **Billing ignores organizations.** Invoices and quotations always bill the client. The firm has tie-ups (e.g. "Taxtable") where the partner organization is the party billed for its clients' work.
- **The client page shows every tab** (GST, E-way Bills…), whatever services the client has actually taken.
- **Assign Service is clumsy.** It takes one service at a time and forces a choice of "Assigned To" (required) and Manager. The user does not want to pick a person there.

## Decisions (user)
1. **Bill to:** a client under an organization is **always billed in the organization's name**. That covers invoices and quotations.
2. **Where:** an always-visible **Organizations** tab on the Clients page with an **Add Organization** button, plus an **Organization** dropdown in Add Client and Edit Client.
3. **Services:** hide client-page tabs for services the client has not taken. The Services tab lists only assigned services. Assign Service lets you **tick several services at once**.
4. **People:** services are added **unassigned**. Work reaches people through the places where it is done: Tasks, the GST Filing page, and so on. Admins and Partners see every client. Associates see the clients they have a task or filing for (the existing rules).

## A. Organizations

### A1. Organizations tab
- The Clients page view chips always show an **Organizations** chip, with a count (0 is fine).
- When that view is active, the header's primary button reads **Add Organization**. It opens `AddClientModal` preset to kind = organization, with the Client/Organization radio hidden.
- In the Organizations view the table lists each organization with:
  - its name and short name
  - the number of clients under it (`child_client_count`)
  - its GSTIN
  - a link that opens its workspace (`/workstation/clients/:id/organization`)
- If no organization exists, show an empty state with the Add Organization button: "No organizations yet. Add the firms you have a tie-up with; their clients are billed in their name."

### A2. Organization dropdown in Add Client / Edit Client
- In **Add Client** (kind = client, opened without a preset organization), add an optional **Organization** select. It lists the active organizations, with "None" as the default.
- The existing backend already accepts `organization_id` on create (`clients.routes.ts`, `assertCanJoinOrganization`) and on PATCH (`organization_id` in body). Reuse that and do not add a new endpoint unless listing organizations needs one. `GET /api/clients?kind=organization` already filters.
- In **Edit Client Details**, add the same select. Changing it re-links the client, and setting "None" unlinks it. Hide the select when the client is itself an organization.
- A hint under the select reads: "Invoices and quotations for this client are billed in the organization's name."

### A3. Billing in the organization's name
**Invoice create, backend** (`invoice/service.ts`, the place that sets `billingName = input.billingName || client.companyName`). When the invoice's client has an `organizationId`:
- **Defaults:** `billingName`, `billingAddress` and `customerGstin` default to the **organization's** `companyName`, `address` and `gstin`, not the client's. Place of supply is derived from the organization's GSTIN, through the existing `defaultPlaceOfSupply` path.
- **Override:** an explicit value in the request still wins, as it does today.
- **Never mix parties:** fall back field by field to the ORGANIZATION only. If the organization has no GSTIN or no address, that field stays null (never the client's), and the builder warns "<Org> has no GSTIN on file. Add it on the organization before sending." An invoice must never carry the organization's name with the client's GSTIN.
- **Recipient:** the invoice send email, payment-link messages and weekly overdue reminders for such an invoice go to the **organization's** email/contact, falling back to the client's only when the organization has none. Check invoice send, `integrations/payment-links.ts` and the overdue reminder job.
- **Notes:** if the invoice has no notes, prefill a notes line `Services for: <client company name> (<client_id>)`. Use the existing customer-notes field that the print already shows. Do not change any print or PDF layout file: `InvoiceDocument.tsx`, `invoice/pdf.ts` and the quotation print are off limits.
- **Ship To:** stays "same as Bill To".
- **Ownership:** `Invoice.clientId` stays the client, so receivables, the client's Invoices tab and reports keep working per client.

**Invoice builder, frontend** (`InvoiceBuilder.tsx`, which currently calls `setBillingName(c.company_name)` on client pick):
- When the picked client has an organization, prefill Bill To from the organization and show a small note: "Billed to <Org> (organization). Change below if needed."
- The client list item needs `organization` (`{id, name}`) and enough to fetch the organization's address and GSTIN. Reuse `getClient` on the organization id if needed.

**Recurring and auto-created invoices** (recurring profiles, quotation → invoice) go through the same backend default, so they inherit it. Verify this with a test.

**Quotations:**
- **Tab:** a client under an organization gets its **Quotations** tab back. Remove `'quotations'` from `ORG_LEVEL_ONLY` in `ClientWorkspace.tsx`; Engagement stays organization-only.
- **Snapshot:** a quotation created for such a client takes its `clientSnapshot` name/GSTIN/address (whatever the snapshot holds today) from the **organization**, and adds `for_client: { name, client_id }`.
- **Display:** the quotation screen shows "For: <client>" from that field. The print stays untouched, but if the print already reads a notes or subject field, put "For: <client>" there.
- **Organization page:** quotations made on the organization itself behave as today.

**Organization's Invoices tab:** it also lists its clients' invoices, with a Client column, so the partner's full billing is visible in one place. Read-only aggregation via `organizationId` → child client ids, plus its own.

## B. Services

### B1. Assignee becomes optional (schema change)
- `ClientService.assignedEmployeeId` changes from `String` to `String?`. This is `DROP NOT NULL`, which safe-push allows.
- Every `tsc` error that follows is fixed so that null means "unassigned". That covers serializers, scope, reminders, GST enrolment and dashboards. A null assignee must never crash anything or notify "undefined".
- `scope.ts` `assignedClientIds` keeps working (a null matches nobody) and **gains a fourth source: clients where the caller is assignee of a live task** (not cancelled, not completed; check the Task status values). Today a task grants only read-only `GET /api/clients/:id` (`assertCanReadClient`). With service assignees gone and Account Manager dropped from Add Client, tasks become the normal way a junior gets a client, so they must get the full client view (list, Documents, Services, Tasks tabs). This is a deliberate access widening the user approved. Simplify `assertCanReadClient` accordingly.
- **Unassigned work still alerts someone:** every reminder, due alert or notification keyed on a ClientService assignee (compliance reminders, follow-up reminders, service due alerts) falls back to the Partner tier (active md + hr_admin users) when the assignee is null. Never nobody, never "undefined".
- **GST Filing enrolment** (`gst/filing.ts`): when the service has no assignee, `GstProfile.assignedEmployeeId` stays null on create. On re-sync, never overwrite an existing profile assignee with null.
- **GST Filing page:** each client row gets an **Assign** select ("Unassigned" + employees, for `workstation.gst.manage`). It sets `GstProfile.assignedEmployeeId`. Check whether an endpoint already exists before adding one. This is how a junior gets GST work and sees the client.

### B2. Assign several services at once
- **Backend:** `POST /api/clients/:id/services` accepts either today's single body (keep it compatible) or `{ service_ids: string[], filing_frequency?, due_date?, notes? }`.
  - It creates one row per service that the client does not already have live. A non-deleted row whose status is not completed or failed counts as live.
  - It skips duplicates and says which ones it skipped.
  - It runs the same side effects per service as today: first-service activation, GST Filing enrolment, activity log.
  - `assigned_employee_id` and `manager_id` become optional but are still accepted, so older callers such as lead conversion keep working.
- **Assign Services modal:**
  - A checkbox list of the catalog, with services the client already has shown ticked and disabled ("already added").
  - A GST frequency select appears when GST Filing is ticked.
  - Optional Due Date and Notes, applied to every ticked service.
  - The button reads "Add N services".
  - No Assigned To and no Manager fields.

### B3. Services tab table
- Columns: Service · Due Date · Status · Last Updated.
- The Assigned To and Manager columns are removed from this table.
- The data stays in the API, and other screens may still show it.
- Due Date is editable inline (date input) for `workstation.service.manage`. `updateService` already exists, so check that it accepts `due_date`.
- Add a **Remove** action per row (confirmAction), only for rows with no tasks or filings. Use the existing delete or end route if there is one; otherwise skip Remove and note it.

### B4. Hide tabs for services not taken
In `ClientWorkspace.tsx`, the service tabs are shown only when the client has a matching live ClientService, **or** when data already exists for that tab, so nothing recorded ever becomes unreachable:

| Tab | Shown when the client has one of |
|---|---|
| GST | GST_FILING, GST_REGISTRATION, E_INVOICE |
| E-way Bills | EWAY_BILL, E_INVOICE |

- Every other tab stays, because each is general and not tied to one service: Overview, Company Details, Services, Compliance (statutory, by entity type), Quotations, Invoices, Engagement, Documents, Follow-ups, Tasks, Activity.
- The "data already exists" check is a count the client detail API returns: `gst_data_exists` (GST profile OR any GST registration case OR GST filings) and `eway_bill_count`. Add them cheaply to the `GET /api/clients/:id` detail payload.
- Opening a hidden tab by URL shows a short message: "This client has no GST service. Add it from Services." It must not show a blank screen.
- **Overview:** the Overview tab shows the client's services as clear chips with status.

## Access
There are no permission changes:
- Organization create and link use `workstation.client.manage`.
- Billing defaults follow the invoice and quotation permissions.
- GST assign uses `workstation.gst.manage`.

## Tests (vitest, backend)
- An invoice for a client under an organization defaults bill-to name, address, GSTIN and place of supply to the organization, plus the "Services for" note. An explicit billing name in the request still wins. A client without an organization behaves as before.
- Quotation → invoice and recurring paths pick up the organization default.
- A quotation for an organization's client snapshots the organization and adds `for_client`.
- The organization's invoices list includes its clients' invoices.
- Multi-assign creates N rows, skips an existing live one, runs GST enrolment once, and works with no assignee. The single-body form still works.
- A null assignee: the serializers, the GST Filing page and reminders don't crash. A due or overdue alert on an unassigned service goes to the Partner tier.
- An Associate with a live task on a client (and no other link) sees it in `/api/clients` and can list its documents and services. Once the task is completed or cancelled, they no longer can.
- An organization with no GSTIN: the invoice for its client has customerGstin null, not the client's.
- Invoice send and overdue reminders for an organization's client go to the organization's email.
- The GST profile assign endpoint sets the assignee, and an Associate then sees that client.
- Client detail returns the new tab-visibility fields.

Frontend: `tsc -b`, `vite build`, `vitest`.

## Deploy
- Schema: one `DROP NOT NULL`. Rehearse safe-push on a fresh prod backup copy before the user pushes.
- Print documents are not changed.
