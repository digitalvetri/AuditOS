import type { AttendanceStatus } from '@/data/models';
import type { StatusVariant } from '@/components/StatusRow';

/** Map storage status → display label + StatusRow variant. */
export function styleForStatus(status: AttendanceStatus): { label: string; variant: StatusVariant } {
  switch (status) {
    case 'present':
      return { label: 'Present', variant: 'ok' };
    case 'late':
      return { label: 'Late', variant: 'pending' };
    case 'absent':
      return { label: 'Absent', variant: 'problem' };
    case 'half_day':
      return { label: 'Half Day', variant: 'pending' };
    case 'wfh':
      return { label: 'Work From Home', variant: 'ok' };
    case 'on_leave':
      return { label: 'On Leave', variant: 'awaiting' };
    case 'missing_check_in':
      return { label: 'Missing Check-in', variant: 'pending' };
    case 'missing_check_out':
      return { label: 'Missing Check-out', variant: 'pending' };
    default:
      return { label: status, variant: 'awaiting' };
  }
}
