import { describe, expect, it } from 'vitest'
import { canApproveCorrection, canApproveExpense, canApproveLeave, type ApproverRights } from '../dashboard-approvable.js'

const manager: ApproverRights = { employeeId: 'emp-mgr', departmentId: 'dep-ops', dept: true, org: false }
const finance: ApproverRights = { employeeId: 'emp-fin', departmentId: 'dep-fin', dept: true, org: true }

describe('canApproveExpense', () => {
  it('lets a department manager approve their own department at the first stage only', () => {
    expect(canApproveExpense(manager, { stage: 'pending_manager', employeeDepartmentId: 'dep-ops' })).toBe(true)
    expect(canApproveExpense(manager, { stage: 'pending_manager', employeeDepartmentId: 'dep-hr' })).toBe(false)
    expect(canApproveExpense(manager, { stage: 'pending_finance', employeeDepartmentId: 'dep-ops' })).toBe(false)
  })

  it('lets an org-wide approver approve both stages', () => {
    expect(canApproveExpense(finance, { stage: 'pending_manager', employeeDepartmentId: 'dep-ops' })).toBe(true)
    expect(canApproveExpense(finance, { stage: 'pending_finance', employeeDepartmentId: 'dep-ops' })).toBe(true)
  })

  it('never offers approve on an expense that is already approved (awaiting payment)', () => {
    expect(canApproveExpense(finance, { stage: 'approved', employeeDepartmentId: 'dep-ops' })).toBe(false)
  })
})

describe('canApproveLeave', () => {
  it('lets the reporting manager approve at the first stage', () => {
    expect(canApproveLeave(manager, { awaitingHr: false, employeeManagerId: 'emp-mgr' })).toBe(true)
    expect(canApproveLeave(manager, { awaitingHr: false, employeeManagerId: 'emp-other' })).toBe(false)
  })

  it('reserves the HR stage for org-wide approvers', () => {
    expect(canApproveLeave(manager, { awaitingHr: true, employeeManagerId: 'emp-mgr' })).toBe(false)
    expect(canApproveLeave(finance, { awaitingHr: true, employeeManagerId: 'emp-mgr' })).toBe(true)
  })
})

describe('canApproveCorrection', () => {
  it('limits department approvers to their own department', () => {
    expect(canApproveCorrection(manager, { employeeDepartmentId: 'dep-ops' })).toBe(true)
    expect(canApproveCorrection(manager, { employeeDepartmentId: 'dep-hr' })).toBe(false)
    expect(canApproveCorrection(finance, { employeeDepartmentId: 'dep-hr' })).toBe(true)
  })
})
