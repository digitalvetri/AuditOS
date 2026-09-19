/**
 * /integrations/zoho-payments — the Zoho Payments integration screen.
 *
 * INTEGRATIONS is a top-level sidebar section (sibling of TOOLS), not
 * an HR concern. Each connected service gets its own route under
 * /integrations; today Zoho Payments is the only one, but the shape is
 * ready for Books, Tally, banking, etc. as they land.
 *
 * Gated on `accounts.manage@organisation` — the same finance permission
 * that owns the Accounts module. An executive without that grant sees a
 * hard 403-shaped block rather than a hidden route (spec §6.3 hides only
 * client-scoped billing data, not the integrations home itself).
 */
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { ZpayIntegrationsSection } from '@/modules/zpay/IntegrationsSection';

export function ZohoPaymentsIntegrationPage() {
  const { session } = useAuth();
  const allowed = can(session?.role.code, 'accounts.manage', 'organisation');

  if (!allowed) {
    return (
      <div className="w-full max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-4 md:p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          Integrations are Finance / MD only.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          Ask a partner or finance admin if you need a connection set up.
        </p>
      </div>
    );
  }

  return (
    <div className="m-page">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Integrations</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Zoho Payments</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Firm-collections integration — the firm's own two Zoho Payments
          accounts. Credentials sit encrypted at rest.
        </p>
      </header>

      <div className="mt-6">
        <ZpayIntegrationsSection />
      </div>
    </div>
  );
}
