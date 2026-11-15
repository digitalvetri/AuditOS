import { describe, expect, it } from 'vitest'
import { clockLeadUpStage, staffStage } from '../reminders.js'

describe('staffStage (recurring forms, unchanged)', () => {
  it.each([
    [-8, null],
    [-7, 'overdue'],
    [-1, 'overdue'],
    [0, 'd1'],
    [1, 'd1'],
    [2, 'd7'],
    [7, 'd7'],
    [8, null],
  ])('daysLeft %d → %s', (daysLeft, want) => {
    expect(staffStage(daysLeft)).toBe(want)
  })
})

describe('clockLeadUpStage', () => {
  const rule10a = [10, 5, 2, 1]
  const inc20a = [30, 15, 7, 2, 1]

  it('Rule 10A — T-10 / T-5 / T-2 / T-1 each fire once', () => {
    expect(clockLeadUpStage(10, 25, rule10a)).toEqual({ stage: 't10', timing: 'lead' })
    expect(clockLeadUpStage(5, 20, rule10a)).toEqual({ stage: 't5', timing: 'lead' })
    expect(clockLeadUpStage(2, 17, rule10a)).toEqual({ stage: 't2', timing: 'lead' })
    expect(clockLeadUpStage(1, 16, rule10a)).toEqual({ stage: 't1', timing: 'lead' })
  })

  it('Rule 10A — between the last lead-up (1) and the internal target, bell chimes daily', () => {
    expect(clockLeadUpStage(0, 15, rule10a)).toEqual({ stage: 'daily-0', timing: 'daily' })
  })

  it('Rule 10A — between lead-ups (e.g. day 4 is not in [10,5,2,1]) → null', () => {
    expect(clockLeadUpStage(4, 19, rule10a)).toBeNull()
    expect(clockLeadUpStage(7, 22, rule10a)).toBeNull()
  })

  it('past internal, statutory still ahead → daily past_internal bell', () => {
    expect(clockLeadUpStage(-1, 14, rule10a)).toEqual({ stage: 'past_internal-1', timing: 'past_internal' })
    expect(clockLeadUpStage(-5, 10, rule10a)).toEqual({ stage: 'past_internal-5', timing: 'past_internal' })
  })

  it('statutory passed → overdue (wins over past_internal)', () => {
    expect(clockLeadUpStage(-30, -1, rule10a)).toEqual({ stage: 'overdue', timing: 'overdue' })
    expect(clockLeadUpStage(-200, -20, inc20a)).toEqual({ stage: 'overdue', timing: 'overdue' })
  })

  it('INC-20A — T-30 fires (recurring staff cadence would have missed it entirely)', () => {
    expect(clockLeadUpStage(30, 180, inc20a)).toEqual({ stage: 't30', timing: 'lead' })
    expect(clockLeadUpStage(15, 165, inc20a)).toEqual({ stage: 't15', timing: 'lead' })
    expect(clockLeadUpStage(7, 157, inc20a)).toEqual({ stage: 't7', timing: 'lead' })
  })

  it('empty leadUps → nothing until overdue', () => {
    expect(clockLeadUpStage(10, 20, [])).toBeNull()
    expect(clockLeadUpStage(-1, -1, [])).toEqual({ stage: 'overdue', timing: 'overdue' })
  })
})
