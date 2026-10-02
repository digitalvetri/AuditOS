import { ReservedScreen } from './ReservedScreen';

export function ToolsPage() {
  return (
    <ReservedScreen
      title="Tools"
      tagline="Firm utilities and integrations. Not yet available."
      capabilities={[
        'Integration centre and connection health',
        'Document template builder and generation',
        'Data import and export',
        'Statutory utilities and calculators',
      ]}
      phase="Planned for Phase 3."
    />
  );
}
