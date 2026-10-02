/**
 * MCA adapter — status PARTIAL.
 *
 * ONE adapter for both PRIVATE_LIMITED and LLP_REGISTRATION; which client's
 * login (and which registration's) comes from the CRM launch context.
 *
 * Inspected 02 Oct 2026: the FO login (…/foportal/fologin.html) is an Adobe AEM
 * form, #guideContainerForm, with
 *   User ID   input[id$="-guidetextbox___widget"]
 *   Password  input[id$="-guidepasswordbox___widget"]
 * The page also carries hidden duplicates (registration panels), so the first
 * VISIBLE match is used. AEM wipes values that did not arrive like typing —
 * handled by setValue(). PARTIAL: not live-tested by us (MCA blocks automated
 * browsers); confirm on a real login.
 */
import { genericAdapter } from '../adapter';

export const mcaAdapter = genericAdapter({
  portalId: 'MCA',
  registrationIds: ['PRIVATE_LIMITED', 'LLP_REGISTRATION'],
  domains: ['mca.gov.in'],
  status: 'PARTIAL',
  selectors: {
    username: '#guideContainerForm input[id$="-guidetextbox___widget"]',
    password: '#guideContainerForm input[id$="-guidepasswordbox___widget"]',
  },
});
