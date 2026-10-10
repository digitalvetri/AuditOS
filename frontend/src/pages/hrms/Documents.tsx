/**
 * /hrms/documents page. Standalone list. Employee sees own only; Manager
 * sees dept; HR/MD see org. Finance is denied at the handler.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/Button';
import { DocumentsTable } from '@/modules/documents/DocumentsTable';
import { UploadModal } from '@/modules/documents/UploadModal';
import { ListHeader } from '@/modules/workstation/listUi';

export function DocumentsPage() {
  const [params] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const withinDays = params.get('expiringWithinDays');
  const filters = withinDays ? { expiringWithinDays: Number(withinDays) } : undefined;

  return (
    <div className="space-y-6">
      <ListHeader
        title="Employee records"
        meta={withinDays ? `Showing documents expiring within ${withinDays} days` : 'ID proofs, certificates and contracts kept on each employee.'}
        action={(
          <Button
            variant="primary"
            onClick={() => setUploadOpen(true)}
            data-testid="document-upload-open"
          >
            Upload
          </Button>
        )}
      />

      <DocumentsTable filters={filters} />

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}
