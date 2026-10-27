"""Fold TrackMan operator split plate appearances.

Operator bug: a PA is closed early (premature Walk/K/out tag), PAofInning
advances, and the same at-bat continues as a "new PA" that starts mid-count.
Rule: if the same batter has consecutive PAs in one GameID/Inning/Top-Bottom
and the second PA's first pitch is not 0-0, fold it into the first PA:
  * second-PA pitches get the first PA's PAofInning; PitchofPA continues on;
  * the first PA's last pitch loses its premature outcome
    (KorBB/PlayResult -> 'Undefined'). OutsOnPlay and RunsScored stay
    as tagged: intersquad taggers use them as intentional inning-flip
    penalties.
Only fold when the first PA's ending is PREMATURE, i.e. its tagged outcome
is impossible for the count on its last pitch (Walk with Balls<3 or a non-ball
pitch; Strikeout with Strikes<2 or a non-strike pitch; a PlayResult on a
non-InPlay pitch; or no outcome at all). A legit ending (ball four at 3-x,
strike three at x-2, ball in play, HBP) is a real PA: the next PA's nonzero
count is just stale count fields, so it is left alone.
Re-bats that start 0-0 are left alone. Placeholder batters whose name
contains 'test' (any case) are skipped. Pitches with a null or blank GameID
are skipped too: they are not a game, and folding them would patch rows that
never get a games row. Never deletes rows. Idempotent.
Set SPLITPA_DRY_RUN=1 to only print what would change.
"""
import os
import sys
from collections import defaultdict

import requests

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import scoring_game_id

URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
DRY = os.environ.get('SPLITPA_DRY_RUN', '0') == '1'
SINCE = os.environ.get('SPLITPA_SINCE', '2026-08-01')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
COLS = 'id,GameID,Date,Inning,"Top/Bottom",PAofInning,PitchofPA,PitchNo,Batter,Balls,Strikes,PitchCall,KorBB,PlayResult'


def fetch():
    rows, off = [], 0
    while True:
        r = requests.get(f'{URL}/rest/v1/pitches', headers=H, timeout=90, params={
            'select': COLS, 'Date': f'gte.{SINCE}', 'order': 'id.asc', 'limit': 1000, 'offset': off})
        r.raise_for_status()
        b = r.json()
        rows += b
        if len(b) < 1000:
            return rows
        off += 1000


BALLS = {'BallCalled', 'BallinDirt', 'BallIntentional', 'IntentionalBall'}
STRIKES = {'StrikeCalled', 'StrikeSwinging', 'FoulTip'}


def premature_end(last):
    """True when the PA-ending tag on `last` is impossible for its count."""
    call = last.get('PitchCall') or ''
    k = last.get('KorBB') or 'Undefined'
    res = last.get('PlayResult') or 'Undefined'
    balls, strikes = last.get('Balls') or 0, last.get('Strikes') or 0
    if call == 'HitByPitch':
        return False
    if k == 'Walk':
        return balls < 3 or call not in BALLS
    if k == 'Strikeout':
        return strikes < 2 or call not in STRIKES
    if res != 'Undefined':
        return call != 'InPlay'
    if call == 'InPlay':
        return False
    return True  # no outcome tagged and not in play: PA never actually ended


def patch(ids, body):
    if DRY:
        return
    r = requests.patch(f'{URL}/rest/v1/pitches', headers=H, timeout=90,
                       params={'id': f'in.({",".join(map(str, ids))})'}, json=body)
    r.raise_for_status()


def rows_for_fold(rows):
    """Split off pitches with no GameID. Those are logged and not patched."""
    kept, skipped = [], []
    for row in rows:
        if scoring_game_id.game_id_missing(row.get('GameID')):
            skipped.append(row)
        else:
            kept.append(row)
    return kept, skipped


def main():
    if not URL or not KEY:
        raise SystemExit('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
    kept, skipped = rows_for_fold(fetch())
    skipped_ids = [int(row['id']) for row in skipped if row.get('id') is not None]
    scoring_game_id.log_null_game_id(
        len(skipped), skipped_ids, 'split-PA',
        'They are not folded and will not get a games row.')
    halves = defaultdict(lambda: defaultdict(list))
    for r in kept:
        halves[(r['GameID'], r['Inning'], r['Top/Bottom'])][r['PAofInning']].append(r)
    folded = 0
    for key, pas in halves.items():
        order = sorted(pas)
        i = 1
        while i < len(order):
            a = sorted(pas[order[i - 1]], key=lambda r: (r['PitchNo'] or 0, r['id']))
            b = sorted(pas[order[i]], key=lambda r: (r['PitchNo'] or 0, r['id']))
            batter = a[0]['Batter']
            # Placeholder rows (name contains "test") are not real plate appearances.
            if any('test' in str(n or '').lower() for n in (batter, b[0]['Batter'])):
                i += 1
                continue
            if (batter == b[0]['Batter'] and (b[0]['Balls'], b[0]['Strikes']) != (0, 0)
                    and premature_end(a[-1])):
                first_pa = order[i - 1]
                maxp = max(r['PitchofPA'] or 0 for r in a)
                print(f'fold {key} {batter}: PA {order[i]} -> {first_pa}')
                # Outcome columns only. Leave OutsOnPlay and RunsScored alone.
                patch([a[-1]['id']], {'KorBB': 'Undefined', 'PlayResult': 'Undefined'})
                for r in b:
                    # Update the row too, so a later fold in this half sees the
                    # continued PitchofPA instead of the pre-fold value.
                    r['PAofInning'] = first_pa
                    r['PitchofPA'] = (r['PitchofPA'] or 0) + maxp
                    patch([r['id']], {'PAofInning': r['PAofInning'], 'PitchofPA': r['PitchofPA']})
                pas[first_pa] = a + b
                del pas[order[i]]
                order.pop(i)
                folded += 1
                continue
            i += 1
    print(f'{"would fold" if DRY else "folded"} {folded} split PA(s)')


if __name__ == '__main__':
    main()
