/**
 * The 17 primary Tally groups (spec §6.5). Seeded per-company at
 * company creation — NOT globally — because a group belongs to a
 * company (isolation rule §6.2).
 *
 * Nature drives how the balance rolls up into the Balance Sheet vs P&L
 * (spec §6.16). `affectsPL = true` groups feed the Profit & Loss;
 * everything else settles on the Balance Sheet.
 */
export type GroupNature = 'assets' | 'liabilities' | 'income' | 'expenses'

export interface PrimaryGroupSeed {
  name: string
  nature: GroupNature
  affectsPL: boolean
}

export const PRIMARY_GROUPS: PrimaryGroupSeed[] = [
  { name: 'Capital Account',       nature: 'liabilities', affectsPL: false },
  { name: 'Current Assets',        nature: 'assets',      affectsPL: false },
  { name: 'Current Liabilities',   nature: 'liabilities', affectsPL: false },
  { name: 'Fixed Assets',          nature: 'assets',      affectsPL: false },
  { name: 'Investments',           nature: 'assets',      affectsPL: false },
  { name: 'Loans (Liability)',     nature: 'liabilities', affectsPL: false },
  { name: 'Sundry Debtors',        nature: 'assets',      affectsPL: false },
  { name: 'Sundry Creditors',      nature: 'liabilities', affectsPL: false },
  { name: 'Sales Accounts',        nature: 'income',      affectsPL: true  },
  { name: 'Purchase Accounts',     nature: 'expenses',    affectsPL: true  },
  { name: 'Direct Expenses',       nature: 'expenses',    affectsPL: true  },
  { name: 'Indirect Expenses',     nature: 'expenses',    affectsPL: true  },
  { name: 'Direct Incomes',        nature: 'income',      affectsPL: true  },
  { name: 'Indirect Incomes',      nature: 'income',      affectsPL: true  },
  { name: 'Duties & Taxes',        nature: 'liabilities', affectsPL: false },
  { name: 'Bank Accounts',         nature: 'assets',      affectsPL: false },
  { name: 'Cash-in-Hand',          nature: 'assets',      affectsPL: false },
]
