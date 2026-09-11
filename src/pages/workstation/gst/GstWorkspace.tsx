/**
 * GST workspace dispatcher.
 *
 * One URL — /workstation/services/gst/:slug/workspace — resolves to the
 * right workspace component based on the service’s shape. Recurring →
 * period board. Project (including externally-triggered Notice Reply) →
 * case pipeline. Retainer (E-Invoicing) has no workspace and redirects
 * back to the handoff page.
 */
import { useParams, Navigate } from 'react-router-dom';
import { findGstService } from './services';
import { GstRecurringWorkspace } from './RecurringWorkspace';
import { GstProjectWorkspace } from './ProjectWorkspace';

export function GstWorkspace() {
  const { slug } = useParams<{ slug: string }>();
  const service = slug ? findGstService(slug) : undefined;

  if (!service) {
    return <Navigate to="/workstation/services/gst" replace />;
  }

  switch (service.shape) {
    case 'recurring':
      return <GstRecurringWorkspace service={service} />;
    case 'project':
    case 'externally-triggered':
      return <GstProjectWorkspace service={service} />;
    case 'retainer':
      // Retainer services have no periodic obligations or cases — they’re
      // continuous. Bounce back to the handoff view.
      return <Navigate to={`/workstation/services/gst/${service.slug}`} replace />;
  }
}
