# HQ Schema

The HQ MVP database schema has already been applied as migration **`hq_mvp_schema`**.

Tables used by this app:

| Table | Purpose |
|-------|---------|
| `hq_recruits` | Recruit pipeline |
| `hq_recruit_touches` | Recruit contact log |
| `hq_players` | Active roster |
| `hq_dev_plans` | Per-player development plans by area |
| `hq_weekly_plans` | Per-player, per-week plan, review notes, and throw counts (see migration below) |
| `hq_program_assignments` | Throwing / S&C / workout assignments |
| `hq_plan_logs` | Throw logs, checkoffs, notes |
| `hq_alerts` | Staff alerts (e.g. overthrow) |
| `hq_practice_days` | Daily practice themes + blocks |
| `hq_knowledge_items` | Knowledge base / clipping store |

Edge function: `hq-unlock` — staff gate code check.

Do not re-apply the migration unless you are resetting a fresh project.

## Not applied yet: `hq_weekly_plans`

`hq/migrations/20261005120000_hq_weekly_plans.sql` adds one row per player per week (`player_id`, `week_of` Monday). It holds the weekly plan, review notes, planned throw counts (`throws_planned`), and an unused `throws_actual` object with the same weekday keys for a later planned-vs-actual row.

RLS matches the other `hq_*` tables: enabled, with a single open `anon` `ALL` policy (`using (true)` / `with check (true)`). Grants match too: `anon` select/insert/update/delete; `authenticated` and `service_role` full table privileges.

The player page still loads if this table is missing. The weekly fields stay blank and save explains that storage is not there yet. Dev plans, assignments, practice, and logs are unchanged.
