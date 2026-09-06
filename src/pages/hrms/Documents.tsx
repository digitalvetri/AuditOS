/**
 * /hrms/documents page. Standalone list. Employee sees own only; Manager
 * sees dept; HR/MD see org. Finance is denied at the handler.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/Button';
import { DocumentsTable } from '@/modules/documents/DocumentsTable';
import { UploadModal } from '@/modules/documents/UploadModal';

export function DocumentsPage() {
  const [params] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const withinDays = params.get('expiringWithinDays');
  const filters = withinDays ? { expiringWithinDays: Number(withinDays) } : undefined;

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Documents</h1>
          {withinDays ? (
            <p className="text-13 text-neutral-500 mt-1">
              Showing documents expiring within {withinDays} days
            </p>
          ) : null}
        </div>
        <Button
          variant="primary"
          onClick={() => setUploadOpen(true)}
          data-testid="document-upload-open"
        >
          Upload
        </Button>
      </header>

      <DocumentsTable filters={filters} />

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}
