import { ReservedScreen } from './ReservedScreen';

export function WorkstationPage() {
  return (
    <ReservedScreen
      title="Workstation"
      tagline="Client compliance work. Not yet available."
      capabilities={[
        'Clients and client 360',
        'Services and engagements',
        'Statutory obligations and the compliance calendar',
        'Document checklists, collection and verification',
        'Filing records and evidence',
      ]}
      phase="Planned for Phase 2."
    />
  );
}
