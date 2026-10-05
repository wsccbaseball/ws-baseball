-- hq_weekly_plans
-- One row per player per week for the HQ player page:
--   weekly plan, review notes, and planned throw counts.
-- throws_actual uses the same weekday keys as throws_planned so a later
-- planned-vs-actual row can be stored without another migration.
--
-- Not applied to the live database. Apply after review.
-- Matches other hq_* tables: RLS on, one open anon ALL policy, and the
-- same grants (anon select/insert/update/delete; authenticated and
-- service_role full table privileges).

create table public.hq_weekly_plans (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.hq_players (id) on delete cascade,
  week_of date not null,
  availability text,
  weekly_focus text,
  bullpen_focus text,
  plan_vs_rhh text,
  plan_vs_lhh text,
  attack_cue text,
  next_outing_goal text,
  self_grade smallint,
  coach_grade smallint,
  what_played text,
  what_needs_work text,
  recovery_focus text,
  coach_notes text,
  throws_planned jsonb not null default '{}'::jsonb,
  throws_actual jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hq_weekly_plans_player_week_key unique (player_id, week_of),
  constraint hq_weekly_plans_availability_check check (
    availability is null
    or availability = any (array['Available'::text, 'Limited'::text, 'Unavailable'::text])
  ),
  constraint hq_weekly_plans_self_grade_check check (
    self_grade is null or (self_grade >= 1 and self_grade <= 10)
  ),
  constraint hq_weekly_plans_coach_grade_check check (
    coach_grade is null or (coach_grade >= 1 and coach_grade <= 10)
  ),
  constraint hq_weekly_plans_throws_planned_check check (jsonb_typeof(throws_planned) = 'object'),
  constraint hq_weekly_plans_throws_actual_check check (jsonb_typeof(throws_actual) = 'object')
);

comment on table public.hq_weekly_plans is
  'Per-player weekly plan, review notes, and throw counts for the HQ player page.';

comment on column public.hq_weekly_plans.week_of is
  'Monday that starts the week (YYYY-MM-DD).';

comment on column public.hq_weekly_plans.throws_planned is
  'Planned throw counts keyed by weekday: mon, tue, wed, thu, fri, sat, sun. Integers. Empty object if unset.';

comment on column public.hq_weekly_plans.throws_actual is
  'Actual throw counts, same weekday keys as throws_planned. Reserved for a later planned-vs-actual row. The player page does not write this yet.';

alter table public.hq_weekly_plans enable row level security;

create policy hq_weekly_plans_anon_all
  on public.hq_weekly_plans
  for all
  to anon
  using (true)
  with check (true);

grant select, insert, update, delete on table public.hq_weekly_plans to anon;
grant all on table public.hq_weekly_plans to authenticated;
grant all on table public.hq_weekly_plans to service_role;
