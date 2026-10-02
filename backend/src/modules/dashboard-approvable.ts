/**
 * Whether the viewer can approve a pending item in one click — the same
 * rules the approve endpoints enforce, so the dashboard queue only offers
 * "Approve" where the call will succeed:
 *
 *   expense    POST /api/expenses/:id/approve            (expenses/routes.ts)
 *              pending_manager → department approver of the same department, or an org-wide approver
 *              pending_finance → org-wide approver only
 *              approved        → nothing to approve (it is waiting for payment)
 *   leave      POST /api/leaves/:id/approve               (leave.routes.ts)
 *              awaiting manager → the employee's reporting manager, or an org-wide approver
 *              awaiting HR      → org-wide approver only
 *   correction POST /api/attendance/corrections/:id/approve (attendance.routes.ts)
 *              org-wide approver, or a department approver of the same department
 *
 * Kept free of Prisma and Express so it is unit-testable.
 */

export interface ApproverRights {
  employeeId: string | null
  departmentId: string | null
  /** `<perm>.approve` held at department scope (or wider). */
  dept: boolean
  /** `<perm>.approve` held at organisation scope. */
  org: boolean
}

export function canApproveExpense(
  r: ApproverRights,
  e: { stage: string; employeeDepartmentId: string | null },
): boolean {
  if (e.stage === 'pending_manager') return r.org || (r.dept && !!r.departmentId && e.employeeDepartmentId === r.departmentId)
  if (e.stage === 'pending_finance') return r.org
  return false
}

export function canApproveLeave(
  r: ApproverRights,
  l: { awaitingHr: boolean; employeeManagerId: string | null },
): boolean {
  if (l.awaitingHr) return r.org
  return r.org || (!!r.employeeId && l.employeeManagerId === r.employeeId)
}

export function canApproveCorrection(r: ApproverRights, c: { employeeDepartmentId: string | null }): boolean {
  return r.org || (r.dept && !!r.departmentId && c.employeeDepartmentId === r.departmentId)
}
