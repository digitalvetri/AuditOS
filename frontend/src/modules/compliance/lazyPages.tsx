/**
 * The compliance pages, code-split. App.tsx mounts these like any page; each
 * loads its chunk on first visit behind the shared skeleton.
 */
import { lazy, Suspense, type ComponentType } from 'react';
import { QuerySkeleton } from '@/modules/workstation/components';

function page<K extends string>(load: () => Promise<Record<K, unknown>>, name: K) {
  const Lazy = lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
  return function CompliancePage() {
    return <Suspense fallback={<QuerySkeleton />}><Lazy /></Suspense>;
  };
}

export const ComplianceCalendarRoute = page(() => import('@/pages/workstation/compliance/ComplianceCalendar'), 'ComplianceCalendarPage');
export const DueDateExtensionsRoute = page(() => import('@/pages/workstation/compliance/DueDateExtensions'), 'DueDateExtensionsPage');
export const NoticesRegisterRoute = page(() => import('@/pages/workstation/compliance/NoticesRegister'), 'NoticesRegisterPage');
export const DscRegisterRoute = page(() => import('@/pages/workstation/compliance/DscRegister'), 'DscRegisterPage');
export const TdsReconRoute = page(() => import('@/pages/workstation/compliance/TdsRecon'), 'TdsReconPage');
