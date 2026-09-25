/**
 * The Registration tab — GST Registration cases plus the REG-01 reference.
 *
 * The cases list is the shared PartnershipClients component, resolved to GST
 * through the ServiceProvider on GstShell — clicking a row opens the shared
 * PartnershipCase screen at ../registration/cases/:caseId. The catalogue
 * detail (portal link, form, output document) sits underneath as a small
 * reference block; it is one paragraph per client, not a workspace.
 */
import { RegistrationServiceDetail } from '../RegistrationServiceDetail';
import { PartnershipClients } from '../partnership/PartnershipClients';

export function GstRegistrationTab() {
  return (
    <div className="space-y-6">
      <PartnershipClients />
      <details className="border border-neutral-200 rounded">
        <summary className="px-4 h-10 flex items-center text-13 text-neutral-700 cursor-pointer select-none">
          About GST Registration (REG-01 → GSTIN)
        </summary>
        <div className="p-4 border-t border-neutral-200">
          <RegistrationServiceDetail slug="gst" embedded />
        </div>
      </details>
    </div>
  );
}
