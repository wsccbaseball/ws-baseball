# Score pitches shortly after a TrackMan upload

The Stuff+ / Location+ / Pitching+ workflow (`.github/workflows/stuff-plus.yml`) still runs every day at **08:00 UTC**. That cron is the backup.

After this change is merged **and** the SQL in this folder is applied, an upload into `public.pitches` also starts that same workflow once the insert batches have been quiet for about 90 seconds. Worst case is a bit under three minutes after the last batch: 90 seconds of quiet, then the next one-minute check.

This was **not** applied to the live Supabase project. Run it only after review.

The workflow on `main` has to contain the `pitches-uploaded` trigger before a dispatch starts a run. Merge the pull request first, then apply the SQL.

## What the database does

The TrackMan uploader inserts pitches in batches (500 rows at a time) and then upserts `public.games`. A **statement-level** trigger on `public.pitches` (`pitches_note_upload`) runs once per `INSERT` statement, not once per row. It only updates a single bookmark row in `private.pitch_upload_dispatch`.

A `pg_cron` job, `dispatch-scoring-after-pitch-upload`, runs every minute and calls `private.dispatch_pitch_scoring()`. That function does nothing until `last_insert_at` is at least 90 seconds old and newer than the last dispatch. One upload, however many batches, produces one GitHub `repository_dispatch`.

The games upsert happens after the pitch inserts, inside that quiet window, so the scoring run normally sees the new `games` row. The trigger does not watch `games`. Grade updates from the scoring job do not insert pitches, so the job does not retrigger itself.

`private` is not an exposed API schema. Leave it off **Project Settings → Data API → Exposed schemas**. The bookmark table has RLS enabled and no policies, and `anon` / `authenticated` / `service_role` have no grants on it.

## 1. GitHub token

Create a token the database can use to call `POST /repos/wsccbaseball/ws-baseball/dispatches`.

Preferred: a **fine-grained** personal access token.

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Resource owner: `wsccbaseball`. If the org requires approval, an owner has to approve the token before it works.
3. Repository access: only `ws-baseball`.
4. Repository permissions: **Contents: Read and write**. GitHub lists `POST /repos/{owner}/{repo}/dispatches` under Contents write. No other permission is required.
5. Copy the token (`github_pat_...`) once.

Classic personal access tokens also work. They need the **`repo`** scope, which is broader than this job. Use one only if the org cannot issue a fine-grained token.

Do not commit the token. Do not put it in GitHub Actions secrets. The workflow already uses its own `GITHUB_TOKEN` plus the existing `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `STUFF_TABLE` secrets. This token is only for the database calling GitHub.

## 2. Store the token in Supabase Vault

Name it exactly:

`github_actions_dispatch_token`

Dashboard: **Project Settings → Vault → New secret**. Name `github_actions_dispatch_token`. Paste the token as the secret. Description, for the next person: `Fine-grained PAT. pg_cron uses it to POST repository_dispatch event pitches-uploaded on wsccbaseball/ws-baseball.`

SQL works too. The SQL editor keeps history, so the Vault screen is the better place. If you use SQL, do not save the statement anywhere:

```sql
select vault.create_secret(
  '<paste token>',
  'github_actions_dispatch_token',
  'PAT for pitches-uploaded repository_dispatch on wsccbaseball/ws-baseball'
);
```

To rotate later, open the secret in Vault, or:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'github_actions_dispatch_token'),
  '<new token>'
);
```

## 3. Extensions

In the dashboard, enable **pg_net**, **pg_cron**, and **Vault** (`supabase_vault`) if they are not already on. The migration also runs `create extension if not exists` for all three. pg_cron is installed in `pg_catalog`, which is what Supabase documents.

## 4. Run the migration

SQL editor, as `postgres`. Paste and run the whole file:

`supabase/migrations/20261027120000_pitch_upload_scoring_dispatch.sql`

Re-running it is safe. `cron.schedule` updates the job when the name already exists. The trigger is dropped and recreated. The bookmark row is kept.

Until the Vault secret exists, the cron job warns and does not call GitHub. Pitch inserts still succeed. The 08:00 UTC run still scores.

## 5. Confirm the wiring

After a real upload (or any insert into `public.pitches`):

```sql
select last_insert_at, last_batch_rows, last_dispatched_at, last_request_id
  from private.pitch_upload_dispatch;
```

`last_batch_rows` is the size of the latest `INSERT` statement, not the whole file. A few seconds later `last_dispatched_at` should still be null. About one to three minutes after the last batch it should fill in, and `last_request_id` is the `pg_net` request id.

```sql
select id, status_code, error_msg, left(content, 300) as content, created
  from net._http_response
 where id = (select last_request_id from private.pitch_upload_dispatch);
```

`204` means GitHub accepted the dispatch. Do not select `net.http_request_queue.headers`. That queue holds the `Authorization` header until the request is sent.

Then open GitHub → Actions → **Stuff+, Location+, and Pitching+ nightly scoring**. The run's event is `repository_dispatch`, and the first step prints `dispatch_source=pitches-insert`. `stuff_rescore` and `location_rescore` are `0` (null-fill), the same as the cron. A manual run can still pass `1`.

Optional check from a machine that has the token in the environment. This starts a live null-fill scoring run:

```bash
curl -sS -o /tmp/dispatch-body.txt -w '%{http_code}\n' \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: ws-baseball-pitch-dispatch" \
  https://api.github.com/repos/wsccbaseball/ws-baseball/dispatches \
  -d '{"event_type":"pitches-uploaded","client_payload":{"source":"manual-test"}}'
```

`204` and an empty body is success.

## Overlapping runs

The workflow concurrency group is `stuff-plus-scoring` with `cancel-in-progress: false`. One run works at a time. If more triggers arrive, one follow-up waits and any older waiting run is dropped. The follow-up still null-fills whatever is unscored, so a dropped waiting run does not leave new pitches ungraded.

The 08:00 UTC schedule uses that same lock. It will not overlap an upload run. If a manual rescore is only waiting (it has not started) and an upload trigger arrives, the waiting rescore is replaced by the upload's null-fill. Start a full rescore when uploads are not landing.

## Pitches with no GameID

A positioning export with no `GameID` column is stored with a null `GameID` and does not get a `games` row (`games.game_id` is the key). The scorers and the split-PA fold now skip those rows and print a line like:

```text
SKIP null GameID: 128 unscored Stuff+ pitch(es) have no GameID. They are not scored and will not get a games row. Example ids: 10421, 10422, 10423
```

Stored grades on those rows are left as they are. Rows that have a GameID are scored as before. Stuff+ still reads the null-GameID pitches when it builds the fastball baseline, so turning this skip on does not move existing game grades.

The upload trigger still fires for an all-null file, so the Actions log shows the skip. The nightly cron does the same check.

## If a dispatch needs to be sent again

```sql
update private.pitch_upload_dispatch
   set last_dispatched_at = null
 where id = 1;
```

The next minute tick sends it, as long as the last insert is already outside the 90-second window. To force a run without waiting, use **Actions → Run workflow** (`workflow_dispatch`). Leave both rescore inputs at `0` unless you mean to rewrite stored grades.

## Remove it

This does not delete the Vault secret and does not disable `pg_net`, `pg_cron`, or Vault.

```sql
select cron.unschedule('dispatch-scoring-after-pitch-upload');
drop trigger if exists pitches_note_upload on public.pitches;
drop function if exists private.dispatch_pitch_scoring();
drop function if exists private.note_pitch_insert();
drop function if exists private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval);
drop table if exists private.pitch_upload_dispatch;
```
