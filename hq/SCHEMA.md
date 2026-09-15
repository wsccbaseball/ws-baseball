# HQ Schema

The HQ MVP database schema has already been applied as migration **`hq_mvp_schema`**.

Tables used by this app:

| Table | Purpose |
|-------|---------|
| `hq_recruits` | Recruit pipeline |
| `hq_recruit_touches` | Recruit contact log |
| `hq_players` | Active roster |
| `hq_dev_plans` | Per-player development plans by area |
| `hq_program_assignments` | Throwing / S&C / workout assignments |
| `hq_plan_logs` | Throw logs, checkoffs, notes |
| `hq_alerts` | Staff alerts (e.g. overthrow) |
| `hq_practice_days` | Daily practice themes + blocks |
| `hq_knowledge_items` | Knowledge base / clipping store |

Edge function: `hq-unlock` — staff gate code check.

Do not re-apply the migration unless you are resetting a fresh project.
