/**
 * Articleship register — GET /api/articleship; edits go through
 * PATCH /api/employees/:id/training.
 */
import { api } from '@/services/api';
import type { ArticledTraining } from '@/data/models';

export interface PersonRef { id: string; full_name: string; employee_code: string }

export interface ArticleshipLeave {
  served_days: number;
  leave_allowed_days: number;
  leave_allowed_full_term_days: number;
  leave_taken_days: number;
  excess_leave_days: number;
  extended_training_end: string | null;
}

export type FormState = 'filed' | 'due' | 'overdue' | 'not_due';

export interface ArticleshipForms {
  form102: { date: string | null; state: FormState };
  form103: { date: string | null; state: FormState; due_date: string };
  form108: { date: string | null; state: FormState };
  form109: { date: string | null; state: FormState };
  alerts: string[];
}

export interface ArticleshipRow {
  employee: PersonRef;
  training: ArticledTraining | null;
  principal: PersonRef | null;
  leave: ArticleshipLeave | null;
  forms: ArticleshipForms | null;
}

export type TrainingPatch = Partial<Pick<ArticledTraining,
  'icai_registration_no' | 'principal_employee_id' | 'training_start' | 'training_end' | 'current_year' | 'stipend_slab'
  | 'stipend_paise' | 'icai_region' | 'form102_date' | 'form103_date' | 'form108_date' | 'form109_date' | 'status'>>;

export const articleshipKeys = { all: ['articleship'] as const };

export const articleshipApi = {
  list: () => api.get<{ items: ArticleshipRow[]; count: number }>('/api/articleship'),
  save: (employeeId: string, body: TrainingPatch) =>
    api.patch<{ training: ArticledTraining; leave: ArticleshipLeave | null }>(`/api/employees/${employeeId}/training`, body),
};
