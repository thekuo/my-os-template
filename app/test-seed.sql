-- Test seed data
-- Today is 2026-10-04

-- Overdue yearly birthday task
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task001', 'owner', 'Birthdays', 'Alex birthday', NULL, '2026-10-01', 'yearly', 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Daily task due today with 3 steps
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task002', 'owner', 'Tasks', 'Daily standup', 'P0', '2026-10-04', 'daily', 1, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Steps for daily task
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task002a', 'owner', 'Tasks', 'Review agenda', NULL, NULL, NULL, 0, 'task002', 0, NULL, NULL, datetime('now'), datetime('now'));

INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task002b', 'owner', 'Tasks', 'Write update', NULL, NULL, NULL, 0, 'task002', 1, NULL, NULL, datetime('now'), datetime('now'));

INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task002c', 'owner', 'Tasks', 'Send to team', NULL, NULL, NULL, 0, 'task002', 2, NULL, NULL, datetime('now'), datetime('now'));

-- Weekly task
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task003', 'owner', 'Tasks', 'Weekly review', NULL, '2026-10-11', 'weekly', 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Monthly task due Jan 31 style edge case (using end-of-month logic)
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task004', 'owner', 'Tasks', 'Pay rent', 'P1', '2026-10-31', 'monthly', 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Non-recurring task due today
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task005', 'owner', 'Tasks', 'Buy groceries', NULL, '2026-10-04', NULL, 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Task due tomorrow
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task006', 'owner', 'Tasks', 'Dentist appointment', NULL, '2026-10-05', NULL, 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Task due this week (Wed, Oct 7)
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task007', 'owner', 'Tasks', 'Project proposal', 'P0', '2026-10-07', NULL, 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Task due later (next week)
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task008', 'owner', 'Tasks', 'Plan vacation', NULL, '2026-10-18', NULL, 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));

-- Weekday task for testing weekday recurrence
INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, starred, parent_task_id, sort_order, notes, completed_at, created_at, updated_at)
VALUES ('task009', 'owner', 'Tasks', 'Sync with team', NULL, '2026-10-09', 'weekdays', 0, NULL, 0, NULL, NULL, datetime('now'), datetime('now'));
