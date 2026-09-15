# Walters State Baseball HQ

Phone-first staff HQ for recruits, roster/dev plans, practice days, and knowledge. Static HTML for GitHub Pages — no build step.

## Open locally

```bash
# from this folder
npx serve .
# or: python3 -m http.server 8080
```

Then open `http://localhost:3000/` (or your port) → `index.html`.

For GitHub Pages, serve this folder as the site (or a `/hq/` subpath). Links assume relative paths:

- Staff app: `index.html` (or `/hq/`)
- Player stub: `player.html`

## Staff gate

1. App shows a lock screen until unlocked.
2. Enter the staff code → `POST {SUPABASE_URL}/functions/v1/hq-unlock` with `{ "code": "..." }` and `apikey` + `Authorization: Bearer <anon>`.
3. On success, stores `localStorage.ws_hq_unlock` as `{ expires }` and unlocks.
4. **Lock again** clears that key.
5. If the edge function is not deployed yet (404), the UI shows a clear error — deploy `hq-unlock` before production use.

Anon key and project URL are embedded (same pattern as other public WS pages). RLS still protects writes; the unlock code is the staff gate.

## Tables (see SCHEMA.md)

Schema migration already applied: **`hq_mvp_schema`**.

- Recruits + touches
- Players + dev plans + program assignments + plan logs
- Alerts (e.g. overthrow when actual throws > planned)
- Practice days (theme + `blocks_json`)
- Knowledge items

## Screens

| Nav | What it does |
|-----|----------------|
| **Home** | Counts, open alerts (resolve), quick links to TrackMan hub `/`, Press Box `/scout/`, builder `/tools/scouting-ingest.html` |
| **Recruits** | List/filter, add, detail + touches |
| **Roster** | Active players, add, detail tabs (Hitting/Pitching, Throwing, S&C, Notes), throw log, assign |
| **Practice** | Today’s practice day create/edit |
| **Knowledge** | List + add clippings |

**Player stub** (`player.html`): pick an active player from a dropdown (not real auth). Shows that player’s plans, assignments, today’s practice, recent logs.

## Known MVP limits

- Unlock is a shared staff code, not per-user auth.
- Player view is a stub dropdown — no real player login.
- No offline sync; needs network to Supabase.
- Soft deletes / archive not fully wired; “active” filter on roster is `active = true`.
- Practice blocks are textarea lines → `{ title, detail }` JSON (simple split).
- Throw overthrow alert is created client-side; resolve from Home.
- No image uploads; knowledge is URL/text/summary/tags only.
- Hash routes in the staff SPA (`#home`, `#recruits`, etc.).

## Stack

- Static HTML/CSS/JS
- [supabase-js v2](https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2) from CDN
- Oswald / system fonts, navy `#0b1c2c` / cream `#f2ead8` / accent `#c45c26`
