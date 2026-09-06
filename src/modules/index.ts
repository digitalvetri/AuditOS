/**
 * Module registration barrel. Importing this file triggers widget
 * registration for every HRMS module. Import from App.tsx once, at boot.
 *
 * Dashboard NEVER imports from a module directly (§6.2). This file exists
 * so registration side-effects run before the Dashboard reads the registry.
 */
import './attendance/widgets';
import './leave/widgets';
import './dashboard/widgets';
import './payroll/widgets';
import './expenses/widgets';
import './accounts/widgets';
import './messages/widgets';
