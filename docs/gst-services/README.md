# GST SERVICES
## What each service is, and how the portal handoff works for it

**Companion to:** `SERVICES-MODULE.md` (shapes and engine) and
`ASSISTED-HANDOFF-PATTERN.md` (the redirect component).

All form numbers, deadlines and thresholds below are marked **[VERIFY]** where they
change with notifications. Seed them as config rows with effective dating, never as
constants.

---

## 1. How the redirect actually works for gst.gov.in

Different from the Protean TAN portal, and worth understanding before you build.

**The GST portal is session-based and login-gated.** A deep link to an internal
page will usually bounce to the login screen and lose the destination. So a
`target.url` alone does not get anyone where they need to be.

**The handoff config for GST therefore carries two things:**

```ts
target: {
  url: 'https://www.gst.gov.in/',
  label: 'GST Portal',
  navPath: [                      // ← the click path, shown as step 2
    'Services',
    'Registration',
    'Amendment of Registration Core Fields',
  ],
}
```

The screen renders: *"Open the GST portal and log in as the client"*, then the
click path as a breadcrumb, then the copy-ready field sheet.

**Where a direct link does work** — pre-login pages like new registration and
track-application-status — use it. Everything post-login uses the path.

**Credentials.** For most of these the firm holds the client's GST portal login.
That goes in the vault per §5 of the handoff pattern: encrypted, masked, revealed
on click, every reveal audit-logged, its own permission.

---

## 2. The eight services at a glance

| Service | Form | Shape | Trigger | Portal destination |
|---|---|---|---|---|
| **Registration** | REG-01 | Project | Client onboarding | Services › Registration › New Registration |
| **Return Filing** | GSTR-1, 3B, CMP-08 | Recurring | Monthly / quarterly | Services › Returns › Returns Dashboard |
| **Annual Return** | GSTR-9, 9C | Recurring (annual) | Financial year end | Services › Returns › Annual Return |
| **Notice Reply** | varies | Project, externally triggered | Department issues a notice | Services › User Services › View Additional Notices and Orders |
| **Amendment** | REG-14 | Project | Client details change | Services › Registration › Amendment of Registration Core / Non-Core Fields |
| **Cancellation** | REG-16 | Project | Business closes or crosses out | Services › Registration › Application for Cancellation |
| **LUT Filing** | RFD-11 | Recurring (annual) | Exporter, start of each FY | Services › User Services › Furnish Letter of Undertaking |
| **E-Invoicing Support** | — | Retainer | Turnover threshold crossed | einvoice1.gst.gov.in and other IRPs |

---

## 3. What each one actually is

### 3.1 GST Registration — Form REG-01

Getting a client a GSTIN. Mandatory above the turnover threshold [VERIFY —
differs for goods vs services and for special category states], and compulsory
regardless of turnover for inter-state suppliers, e-commerce operators, casual
taxable persons and others.

**Two parts.** Part A takes PAN, mobile and email, verifies by OTP, and issues a
Temporary Reference Number. Part B is the substance: business constitution,
promoters and partners, authorised signatory, principal place of business,
additional places, goods and services with HSN/SAC, bank account, and state
jurisdiction.

**Then either Aadhaar authentication or physical verification of premises.**
Aadhaar authentication is much faster; failing it routes the application to site
visit, which adds weeks. Getting the authorised signatory's Aadhaar right matters.

Outcome: an ARN, then Form REG-06 — the registration certificate carrying the
GSTIN.

**What the firm actually does:** collect and verify documents, get the
constitution and place-of-business proof right, choose HSN codes sensibly, and
handle Form REG-03 if the officer raises a query — which has a short reply window
via REG-04. Missing that window means the application is rejected and you start
over.

### 3.2 GST Return Filing — the recurring core

Not one return. A set that depends on the client's registration type and filing
frequency.

| Return | Who | Frequency | Due [VERIFY] |
|---|---|---|---|
| GSTR-1 | Regular taxpayers | Monthly | 11th of following month |
| GSTR-1 (QRMP) | Small taxpayers opting quarterly | Quarterly | 13th after quarter end |
| IFF | QRMP filers, optional | Monthly | For B2B invoices in months 1 and 2 |
| GSTR-3B | Regular taxpayers | Monthly | 20th of following month |
| GSTR-3B (QRMP) | QRMP filers | Quarterly | State-group dependent |
| CMP-08 | Composition dealers | Quarterly | 18th after quarter end |
| GSTR-2B | — | Monthly | Auto-drafted, read-only, not filed |

GSTR-1 reports outward supplies. GSTR-3B is the summary return where tax is
actually paid. GSTR-2B is the system-generated ITC statement the firm reconciles
purchases against.

**This is where your Audit Automation module plugs in** — 2B ingestion,
reconciliation and ITC computation happen there, and the return service consumes
the finalised figure.

### 3.3 GST Annual Return — GSTR-9 and GSTR-9C

**GSTR-9** consolidates the whole financial year — all outward supplies, ITC
claimed, tax paid, and any amendments made. **GSTR-9C** is a reconciliation
statement between the audited financial statements and GSTR-9, self-certified,
required above a turnover threshold [VERIFY current threshold and whether 9 itself
is optional below a lower threshold].

Due 31 December following the financial year [VERIFY].

**What the firm actually does:** reconcile twelve months of GSTR-1 and GSTR-3B
against the books, explain every difference, and correct what can still be
corrected. This is real work — mismatches accumulated across the year surface
here, and it is the return most likely to attract scrutiny later.

### 3.4 GST Notice Reply

Reactive. The department issues something, there is a hard deadline, and the reply
must be filed on the portal.

| Notice | What it is | Reply |
|---|---|---|
| REG-03 | Query on a registration application | REG-04 |
| GSTR-3A | Notice for non-filing of returns | File the pending returns |
| ASMT-10 | Discrepancy found on scrutiny of returns | ASMT-11 |
| DRC-01A | Intimation of tax ascertained before a show-cause | DRC-03 to pay, or reply |
| DRC-01 | Show-cause notice | DRC-06 |
| REG-17 | Show cause for suo-moto cancellation | REG-18 |
| CMP-05 | Query on composition eligibility | CMP-06 |

All of them live under **Services › User Services › View Additional Notices and
Orders**.

**The operational problem is not the reply. It is knowing the notice exists.** The
portal does not push notifications reliably, and a missed ASMT-10 becomes a DRC-01
becomes a demand order. A weekly scheduled task per client to check the notices
tab is genuinely valuable, and it is the sort of thing a portal is good at and a
person is not.

Each notice becomes a case with its own deadline taken from the notice itself, not
from a calendar.

### 3.5 GST Amendment — Form REG-14

Changing registration details. Splits into two categories that behave completely
differently.

**Core fields** — legal name of business, principal place of business, additional
places, and addition or removal of partners, directors or karta. These require
officer approval, may attract a REG-03 query, and take time.

**Non-core fields** — bank account details, contact information, most other
changes. Auto-approved on submission, effective immediately.

Your UI must make the distinction obvious before submission, because a client
expecting an instant change to their trade name will be surprised.

Some things cannot be amended at all — a change of PAN or a change of state means
new registration and cancellation of the old one, not an amendment. Say so
explicitly rather than letting someone try.

### 3.6 GST Cancellation — Form REG-16

Surrendering a GSTIN. Business closed, turnover fell below threshold, constitution
changed, or the business was transferred or merged.

Flow: REG-16 application → officer review → REG-19 cancellation order.

**Two things people forget, and both bite:**

**GSTR-10, the final return**, must be filed within a window after cancellation
[VERIFY current period]. Missing it attracts a late fee and keeps the liability
open long after the client thinks they are done.

**Revocation** — if the department cancelled the registration suo-moto, the client
can apply to revoke via REG-21, within a limited window [VERIFY]. That is a
separate case type, and the window is short.

Also: all returns up to the cancellation date must be filed first. The cancellation
case should block until they are.

### 3.7 GST LUT Filing — Form RFD-11

A Letter of Undertaking lets an exporter ship goods or services **without paying
IGST upfront** and then claiming a refund. Without it the exporter pays IGST and
waits for a refund, which is a working capital problem.

**Filed annually, at the start of each financial year.** It is not carried forward.
Needs two witnesses with names, addresses and occupations.

This is a small, easy, high-value service, and the entire job is remembering to do
it in April. Model it as a recurring annual obligation and it never gets missed —
which is exactly the kind of thing a client notices.

### 3.8 GST E-Invoicing Support

Not a filing. Ongoing support for clients whose turnover has crossed the
e-invoicing threshold [VERIFY current threshold].

Every B2B invoice and export invoice must be reported to an Invoice Registration
Portal, which returns an **IRN** and a signed **QR code**. An invoice without a
valid IRN is not a valid tax invoice, and the buyer's ITC is at risk.

**What the firm actually does:** determine applicability when turnover crosses the
threshold, help set up the client's billing software or IRP access, and handle the
operational edges. The two that cause the most trouble:

- **Cancellation is only permitted within a short window after generation**
  [VERIFY current duration]. After that, a credit note is the only remedy.
- **E-invoice data auto-populates GSTR-1**, so errors flow straight into the
  return — which means catching them at generation matters more than catching them
  at filing.

Retainer shape. There is no deadline, only continuous correctness.

---

## 4. Shape mapping

Three of the four shapes from `SERVICES-MODULE.md`, plus one variant.

**Recurring** — Return Filing, Annual Return, LUT. Period board, deadline-driven,
obligation per period.

**Project** — Registration, Amendment, Cancellation. Case pipeline, stage-driven,
one-off.

**Project, externally triggered** — Notice Reply. Same case machinery, but the
deadline comes from the notice document rather than from a calendar, and the case
is created by a discovery task rather than by a client request. The only real
difference is where `target_date` comes from — no new workspace needed.

**Retainer** — E-Invoicing Support. Continuous, no deadline.

So the Services engine already handles all eight. No new shape required.

---

## 5. Handoff configuration

One config object per operation. The component is already built.

```ts
// gst.registration.submit
{
  operationId: 'gst.registration.submit',
  target: {
    url: 'https://www.gst.gov.in/',
    label: 'GST Portal',
    navPath: ['Services', 'Registration', 'New Registration'],
    preLogin: true,                    // this one works without a session
  },
  guard: () => allDocumentsVerified() && hsnCodesSelected()
                && authorisedSignatoryAadhaarConfirmed(),
  fields: [ /* REG-01 Part B, in the portal's own field order */ ],
  capture: [
    { key: 'trn',  label: 'TRN',  type: 'text', required: true },
    { key: 'arn',  label: 'ARN',  type: 'text', required: true,
      validate: arnFormat },
    { key: 'ack',  label: 'Acknowledgement', type: 'document', required: true },
  ],
}
```

```ts
// gst.amendment.core
{
  operationId: 'gst.amendment.core',
  target: {
    url: 'https://www.gst.gov.in/',
    label: 'GST Portal',
    navPath: ['Services', 'Registration',
              'Amendment of Registration Core Fields'],
    preLogin: false,                   // login required — path is the guide
  },
  credentials: { vaultRef: 'gst.portal', scope: 'client' },
  fields: [ /* only the changed fields, old value shown beside new */ ],
  capture: [
    { key: 'arn', label: 'ARN', type: 'text', required: true },
  ],
}
```

**For amendments, show the old value next to the new one on the field sheet.** The
person is editing an existing record on the portal, not filling a blank form, and
needs to see what they are replacing.

Same pattern for the remaining six. Each is a URL, a nav path, a guard, a field
list and a capture schema. **Zero component changes.**

---

## 6. Missing from that menu

Four services the competitor's list does not show, which your clients will need.

**GST Refund — Form RFD-01.** Exporters with LUT, inverted duty structure, excess
cash ledger balance. Genuinely valuable and frequently needed by the same exporter
clients who need LUT. Project shape.

**GST Appeal — Form APL-01.** When a demand order is unfavourable. Strict time
limit from the order date [VERIFY], with a pre-deposit requirement. Project shape,
externally triggered, same as Notice Reply.

**E-Way Bill.** Already in your Services tree as a separate item. Transactional
shape.

**Composition scheme opt-in and opt-out — CMP-02 and CMP-04.** Annual window at
the start of the financial year. Small but easy to miss.

---

## 7. Build order

Build the shape first, then services are configuration.

| Order | Build | Why |
|---|---|---|
| 1 | **Return Filing** on the recurring workspace | Highest volume, most revenue, exercises the whole engine |
| 2 | **Registration** on the project workspace | Proves the project shape and the full handoff pattern |
| 3 | **LUT** | Configuration only on the recurring workspace — should take a day |
| 4 | **Amendment + Cancellation** | Configuration only on the project workspace |
| 5 | **Notice Reply** + the weekly notice-check task | Needs the discovery task, which is new |
| 6 | **Annual Return** | Depends on twelve months of return data existing |
| 7 | **E-Invoicing Support** | Retainer shape, lowest urgency |

**Steps 3 and 4 are the architecture test.** If adding LUT, Amendment and
Cancellation needs more than configuration, the shapes are wrong — and you will
have found out in week three rather than month three.

---

## 8. Three things to confirm with the firm

**Which of these eight do they actually sell?** A menu on a competitor's website is
marketing. If the firm does two GST cancellations a year, it is a checklist, not a
module.

**Do they hold client GST portal credentials?** This determines whether the vault
in §5 is central to the design or optional. Ask before building it, and ask whether
they are comfortable with it being stored.

**Does anyone currently check the notices tab per client, and how often?** If the
answer is "when the client tells us," the weekly discovery task in §3.4 is probably
the highest-value single feature in this entire GST module — and it is also the
cheapest to build.
