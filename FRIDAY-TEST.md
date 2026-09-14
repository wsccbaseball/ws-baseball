# Friday test — TrackMan trusted upload

## Important (read first)

After this HTML is **deployed** to GitHub Pages, the live uploader **requires** the upload secret. The page no longer writes via public REST (`/rest/v1/games` / `/rest/v1/pitches`); all DB writes go through the `trackman-ingest` Edge Function with header `x-upload-secret`.

**Until RLS lockdown:** the old public REST write policies can still accept inserts if someone uses an **old cached** copy of the uploader (or any other client with the anon key). After deploy, the **current** Pages uploader will not use those REST writes anymore — but strangers can still write via REST until guest writes are locked.

**Do not lock guest writes until Friday’s test upload succeeds.**

---

## Steps

1. **Add Edge secret in Supabase**
   - Supabase → Project Settings → Edge Functions → Secrets (or CLI `supabase secrets set`).
   - Name: `UPLOAD_SECRET`
   - Value: provided by Chief of Staff in chat (do not commit it; do not put it in the repo).

2. **Deploy** this updated `WS_TrackMan_Uploader.html` to the `ws-baseball` Pages site (normal push/deploy). Confirm `trackman-ingest` is deployed and wired to the same secret.

3. **Open the uploader on Pages** (hard-refresh / cache-bypass so you are not on an old HTML).
   - Paste the **same** secret into **Upload Secret** once.
   - It is stored only in this browser (`localStorage` key `ws_trackman_upload_secret`).

4. **Upload a small TrackMan CSV on Friday**
   - Confirm progress/log shows success via ingest (not REST).
   - Confirm pitch/game counts look right in Supabase / the hub.

5. **Tell Chief of Staff to lock guest writes**
   - Only after step 4 succeeds.
   - Then anon INSERT/UPDATE/DELETE on `games` / `pitches` should fail; Sean’s uploader (secret + `trackman-ingest`) should still work.

---

## Until Friday

- Old public REST writes still work for anyone using an old cached page or direct REST with the anon key.
- After deploy, the live uploader page itself requires the secret and will not fall back to public REST writes.
