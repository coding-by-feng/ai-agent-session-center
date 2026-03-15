/**
 * Agenda types — personal task/todo management.
 */

export type AgendaPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface AgendaTask {
  id: string;
  title: string;
  description?: string;
  priority: AgendaPriority;
  tags: string[];
  dueDate?: string;      // ISO date string (YYYY-MM-DD)
  completed: boolean;
  completedAt?: string;   // ISO timestamp
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
}

export interface AgendaFilter {
  search: string;
  priority: AgendaPriority | 'all';
  tag: string | 'all';
  showCompleted: boolean;
  sortBy: 'priority' | 'dueDate' | 'createdAt';
}
