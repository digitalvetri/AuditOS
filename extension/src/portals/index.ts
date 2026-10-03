/** Adapter lookup by portalId. */
import type { PortalAdapter } from './adapter';
import { gstAdapter } from './gst/gst-adapter';
import { mcaAdapter } from './mca/mca-adapter';
import { tnreginetAdapter } from './tnreginet/tnreginet-adapter';
import { udyamAdapter } from './udyam/udyam-adapter';
import { labourAdapter } from './labour/labour-adapter';
import { dgftAdapter } from './dgft/dgft-adapter';
import { epfoAdapter } from './epfo/epfo-adapter';
import { esicAdapter } from './esic/esic-adapter';
import { einvoiceAdapter } from './einvoice/einvoice-adapter';
import { ewaybillAdapter } from './ewaybill/ewaybill-adapter';
import { itdAdapter } from './itd/itd-adapter';

const ADAPTERS: PortalAdapter[] = [gstAdapter, mcaAdapter, tnreginetAdapter, udyamAdapter, labourAdapter, dgftAdapter, epfoAdapter, esicAdapter, einvoiceAdapter, ewaybillAdapter, itdAdapter];

export function adapterFor(portalId: string, registrationId: string): PortalAdapter | null {
  const a = ADAPTERS.find((x) => x.portalId === portalId) ?? null;
  return a && a.registrationIds.includes(registrationId) ? a : null;
}
