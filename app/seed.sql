-- Small generic example seed (placeholder tasks). Replace with your own, or skip it.
-- Dates are examples; edit them before loading.
INSERT INTO tasks (id, list, title, priority, due_date, recurrence, parent_task_id, sort_order, created_at, updated_at) VALUES
 ('t-plants', 'Tasks', 'Water the plants', NULL, '2026-10-04', 'weekly', NULL, 0, datetime('now'), datetime('now')),
 ('t-electric', 'Tasks', 'Pay the electric bill', 'P0', '2026-10-10', 'monthly', NULL, 0, datetime('now'), datetime('now')),
 ('t-groceries', 'Tasks', 'Weekly grocery run', NULL, '2026-10-10', 'weekly', NULL, 0, datetime('now'), datetime('now')),
 ('t-inbox', 'Tasks', 'Inbox zero', 'P1', '2026-10-05', 'daily', NULL, 0, datetime('now'), datetime('now')),
 ('t-exercise', 'Tasks', 'Exercise', 'P1', '2026-10-05', 'daily', NULL, 0, datetime('now'), datetime('now')),
 ('t-trash', 'Tasks', 'Take out the trash', NULL, '2026-10-07', 'weekly', NULL, 0, datetime('now'), datetime('now')),
 ('t-review', 'Tasks', 'Monthly budget review', 'P1', '2026-10-28', 'monthly', NULL, 0, datetime('now'), datetime('now')),
 ('t-checkup', 'Tasks', 'Schedule annual checkup', NULL, '2026-11-15', 'yearly', NULL, 0, datetime('now'), datetime('now')),
 ('t-registration', 'Tasks', 'Renew vehicle registration', 'P0', '2027-01-15', 'yearly', NULL, 0, datetime('now'), datetime('now')),
 ('bd-alex', 'Birthdays', 'Birthday: Alex', NULL, '2026-12-01', 'yearly', NULL, 0, datetime('now'), datetime('now'));
