/**
 * Deactivate action (HR/MD). Two-step: click → confirm → call handler.
 * The server does the compound work (soft delete + user.is_active=false).
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { employeeApi } from './api';

interface Props {
  employeeId: string;
  employeeName: string;
}

export function DeactivateButton({ employeeId, employeeName }: Props) {
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const m = useMutation({
    mutationFn: () => employeeApi.deactivate(employeeId),
    onSuccess: () => {
      toast.push('success', `${employeeName} deactivated.`);
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['employee', employeeId] });
      setConfirming(false);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (!confirming) {
    return (
      <Button
        variant="secondary"
        onClick={() => setConfirming(true)}
        data-testid="employee-deactivate"
      >
        Deactivate
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-12 text-neutral-500">
        Deactivate {employeeName}? Revokes their login.
      </span>
      <Button
        variant="primary"
        disabled={m.isPending}
        onClick={() => m.mutate()}
        data-testid="employee-deactivate-confirm"
      >
        Confirm
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}
