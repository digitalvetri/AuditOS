# extension/ — AuditOS Government Portal Autofill (Chrome, Manifest V3)

Internal tool, **not** a password manager. When someone in the CRM clicks a
registration for a client (e.g. *ABC Private Limited → LLP*), the official
portal opens in a new tab and this extension fills **that client's login for
that registration** — nothing else. CAPTCHA, OTP, MFA and DSC are always left
to the person.

The identity of a credential is always **client + registration + portal**.
Private Limited and LLP share the MCA portal, so the domain alone never picks
a credential.

## Load it (developers / staff machines)

```bash
cd extension
npm install
npm run build          # → extension/dist
```

Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
→ choose `extension/dist`. Open the CRM; client pages show
"Autofill extension connected".

## How it works

```
CRM (client + registration)  ──POST /api/portal-autofill/launch──▶  backend
   │  short-lived, signed, single-use token (no password, nothing in the URL)
   ▼
crm-bridge.js (content script on the CRM) ──▶ service worker
   │  opens the official starting URL in a NEW TAB; stores the token for that tab only
   │  (chrome.storage.session — memory only, never synced, not readable by pages)
   ▼
portal.js (content script on allowlisted portal domains)
   │  page must belong to that tab's portal (after any redirect)
   ▼
service worker ──POST /api/extension/credentials/request──▶ backend
   │  backend re-checks: valid + unexpired + unused token, same client / registration /
   │  portal, page URL on that portal, user still active and allowed to reveal it
   ▼
ONE {username, password} → filled into the form → dropped from memory
```

- Switching clients in the CRM never changes an already-open portal tab — the
  tab keeps the context it was opened with.
- Many portals open their login in a NEW tab (ESIC "Employer Login", EPFO's
  employer portal, Labour TN's Login). A tab opened from the launched portal tab
  carries the same launch (same client + registration + portal, same domain
  checks, still one fill per launch). Tabs opened any other way get nothing. An expired or used token never
  fills ("CRM session expired. Please reopen this service from the CRM.").
- Passwords are never written to chrome.storage, localStorage, the console,
  the page (beyond the two inputs) or any URL. Audit rows hold metadata only.

## Portal status (be honest)

Every portal responds by itself: open the portal from the CRM, open its login
on the site, and the login fills as soon as the form appears (the extension
keeps watching while the launch is valid, max 10 minutes). Login pages were
inspected on **02 Oct 2026**:

| Portal | Where the login is | Filled | Status |
|---|---|---|---|
| GST | services.gst.gov.in/services/login | `#username`, `#user_pass` | **SUPPORTED** |
| E-Invoice | GST login page `services.gst.gov.in/services/login?flag=einvoice` (uses the **E-Invoice** login, not GST's) | `#username`, `#user_pass` | **SUPPORTED** |
| E-Way Bill | ewaybillgst.gov.in/Login.aspx | `#txt_username`, `#txt_password` | **SUPPORTED** |
| ESIC (Employer) | portal.esic.gov.in/…/Portal_Loginnew.aspx ("Employer Login" opens it in a new tab) | `#txtUserName`, `#txtPassword` | **SUPPORTED** |
| Labour TN (Shops & Est.) | labour.tn.gov.in/services/users/login (opens in a new tab) — only `/services/` pages, never other systems on the domain such as `/ism/` | `form#userLogin` `username`, `password` | **SUPPORTED** |
| TNREGINET (Partnership) | hidden `#LoginForm` on tnreginet.gov.in/portal/ (opens from the registration tile) | `#username`, `#password` | **PARTIAL** |
| DGFT (IEC) | Login pop-up on dgft.gov.in/CP/ — the extension opens it | `#username`, `#password` | **PARTIAL** |
| UDYAM | Udyam_Login.aspx — no password | Udyam number + mobile | **PARTIAL** |
| Income Tax e-Filing | eportal.incometax.gov.in/iec/foservices/#/login — two screens: User ID → Continue → password | `#panAdhaarUserId`, then the visible password box | **PARTIAL** — screen 1 inspected; the site blocks automated browsers, so not live-tested by us |
| MCA (Private Limited, LLP) | foportal/fologin.html — Adobe AEM form `#guideContainerForm` | User ID `…-guidetextbox___widget`, Password `…-guidepasswordbox___widget` (first visible) | **PARTIAL** — page inspected; live fill not tested by us |
| EPFO (Employer) | unifiedportal-emp.epfindia.gov.in/epfo/ — `#AuthenticationForm` | `#username1`, `#password` | **PARTIAL** — page inspected; live fill not tested by us |

CAPTCHA, OTP, verification codes, MFA and DSC are never filled. If a portal
changes its page, update the selectors in `src/portals/<portal>/<portal>-adapter.ts`.

## Test

```bash
npm test               # context / isolation rules (extension)
cd ../backend && npx vitest run src/modules/portal-autofill   # token + credential isolation (API)
```

Values are entered like typing (native setter + input / key / change events,
read back, re-typed per character if a page wipes them, restored if a blur
clears them) — this is what makes AEM (MCA), ASP.NET and Angular forms keep
the value. Nothing is ever submitted.

## Remove the feature

Delete `extension/`, `backend/src/modules/portal-autofill/`,
`frontend/src/modules/portalAutofill/`, `docs/portal-autofill/`, and the
marked lines in `backend/src/app.ts`, `frontend/src/pages/workstation/ClientWorkspace.tsx`
and `frontend/src/pages/workstation/registration/RegistrationRunPanel.tsx`.

## Build with Docker (no Node on the machine)

```bash
cd docker
docker compose --profile tools run --rm extension-build   # → extension/dist
```

The backend part of this feature ships inside the normal `api` image — no
extra Docker configuration. `PORTAL_ACCESS_ENC_KEY` (already required) also
derives the launch-token signing key; set `PORTAL_AUTOFILL_SECRET` to use a
separate one.
