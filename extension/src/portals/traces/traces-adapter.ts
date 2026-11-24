/**
 * TRACES adapter — status NOT_VERIFIED.
 *
 * TRACES (TDS Reconciliation Analysis and Correction Enabling System) is the
 * deductor-login half of the Income Tax Department's TDS stack. The entry
 * URL https://traces.tdscpc.gov.in/ is a JS-rendered shell — its login form
 * HTML was not inspectable headlessly when this adapter was added, so there
 * are no pinned selectors. The generic heuristic in `adapter.ts`
 * (`findPassword()` + `findUsernameFor()`) handles the fill until a developer
 * inspects the live page and adds exact selectors — at that point lift the
 * status to PARTIAL or SUPPORTED to match the other adapters.
 *
 * The credential source on the server is TdsPortalCredential (clientId,
 * userId=TAN, encrypted password); see backend/src/modules/portal-autofill/
 * routes.ts → credentialFor().
 */
import { genericAdapter } from '../adapter';

export const tracesAdapter = genericAdapter({
  portalId: 'TRACES',
  registrationIds: ['TDS_TRACES'],
  domains: ['tdscpc.gov.in'],
  status: 'NOT_VERIFIED',
});
