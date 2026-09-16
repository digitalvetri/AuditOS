/**
 * The Registration tab — the original GST Registration page, unchanged.
 * It is rendered with an explicit slug because the shell's route is the
 * literal `registration/gst`, so there is no `:slug` param to read.
 */
import { RegistrationServiceDetail } from '../RegistrationServiceDetail';

export function GstRegistrationTab() {
  return <RegistrationServiceDetail slug="gst" embedded />;
}
