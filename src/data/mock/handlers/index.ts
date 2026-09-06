import { authHandlers } from './auth';
import { dashboardHandlers } from './dashboard';
import { dashboardAggregateHandlers } from './dashboardAggregates';
import { attendanceHandlers } from './attendance';
import { leaveHandlers } from './leave';
import { settingsHandlers } from './settings';
import { employeeHandlers } from './employees';
import { notificationHandlers } from './notifications';
import { documentHandlers } from './documents';
import { payrollHandlers } from './payroll';
import { expenseHandlers } from './expenses';
import { accountsHandlers } from './accounts';

/**
 * MSW handler registry. New modules append their handler arrays here.
 *
 * Order matters when patterns overlap. Put SPECIFIC paths before parametric
 * ones — `/api/attendance/today` and `/api/attendance/corrections` must
 * appear before `/api/attendance/:employeeId`, or MSW picks the wildcard.
 */
export const handlers = [
  ...authHandlers,
  ...dashboardHandlers,
  ...dashboardAggregateHandlers,
  ...notificationHandlers,
  ...attendanceHandlers,
  ...leaveHandlers,
  ...settingsHandlers,
  ...employeeHandlers,
  ...documentHandlers,
  ...payrollHandlers,
  ...expenseHandlers,
  ...accountsHandlers,
];
