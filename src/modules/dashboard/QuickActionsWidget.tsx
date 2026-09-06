/**
 * Employee "Quick Actions" widget (§6.2). Four named actions:
 *   Apply Leave · Submit Expense · View Payslip · Open Messages
 *
 * Apply Leave routes to /hrms/leave with a state hint the page could read
 * to auto-open the modal. Expense/Payslip/Messages disabled — Part 2.
 */
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/Button';

export function QuickActionsWidget() {
  const navigate = useNavigate();
  return (
    <div data-testid="quick-actions">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Quick actions</div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate('/hrms/leave')}
          className="w-full"
          data-testid="qa-apply-leave"
        >
          Apply leave
        </Button>
        <Button
          variant="secondary"
          disabled
          className="w-full"
          title="Available when Expenses (Part 2) ships"
        >
          Submit expense
        </Button>
        <Button
          variant="secondary"
          disabled
          className="w-full"
          title="Available when Payroll (Part 2) ships"
        >
          View payslip
        </Button>
        <Button
          variant="secondary"
          disabled
          className="w-full"
          title="Available when Messages (Part 2) ships"
        >
          Open messages
        </Button>
      </div>
    </div>
  );
}
