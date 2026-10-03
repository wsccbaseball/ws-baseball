"""Write one prebuilt season file per season for the hitting and pitching pages.

Reads games and pitches. Does not insert, update, or delete anything, and does
not recompute Stuff+, Location+, or Pitching+. Stored stuff grades are copied
through so the pitching page can show the same numbers it shows today.

The nightly scoring workflow runs this after the graders. The TrackMan uploader
does not write these files.
"""
import json
import os
import sys
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'data', 'seasons')

URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_ANON_KEY') or ''
HEADERS = {
    'apikey': KEY,
    'Authorization': f'Bearer {KEY}',
    'Accept': 'application/json',
}

# Columns the season pages actually read. Extra TrackMan columns stay in the
# database. stuff_plus_* are copied, never recalculated.
COLUMNS = [
    'id',
    'GameID',
    'Pitcher', 'PitcherThrows', 'PitcherTeam',
    'Batter', 'BatterSide', 'BatterTeam',
    'Inning', 'PitchofPA', 'Balls', 'Strikes',
    'TaggedPitchType', 'AutoPitchType',
    'PitchCall', 'KorBB', 'PlayResult',
    'TaggedHitType', 'AutoHitType',
    'RelSpeed', 'SpinRate', 'SpinAxis',
    'InducedVertBreak', 'HorzBreak',
    'PlateLocHeight', 'PlateLocSide',
    'VertApprAngle', 'RelHeight', 'RelSide', 'Extension',
    'ExitSpeed', 'Angle', 'Direction', 'Distance', 'Bearing',
    'ContactPositionX', 'ContactPositionY', 'ContactPositionZ',
    'stuff_plus_juco', 'stuff_plus_d1',
]


class Num(str):
    """Decimal text copied from the REST payload, so a rewrite cannot drift."""


def _loads(raw):
    return json.loads(raw, parse_int=Num, parse_float=Num)


def _dumps(obj):
    text = json.dumps(_mark(obj), ensure_ascii=False, separators=(',', ':'))
    return _unmark(text)


def _mark(obj):
    if isinstance(obj, Num):
        return {'$n': str(obj)}
    if isinstance(obj, list):
        return [_mark(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _mark(v) for k, v in obj.items()}
    return obj


def _unmark(text):
    # Numeric tokens were wrapped as {"$n":"..."}. They contain no quotes.
    out = []
    i = 0
    token = '{"$n":"'
    while True:
        j = text.find(token, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = text.find('"}', j + len(token))
        if k < 0:
            raise ValueError('broken numeric token')
        out.append(text[j + len(token):k])
        i = k + 2
    return ''.join(out)


def _compact(row, keys):
    out = {}
    for key in keys:
        if key not in row or row[key] is None:
            continue
        out[key] = row[key]
    return out


def fetch_all(table, params):
    rows = []
    offset = 0
    while True:
        query = dict(params)
        query['limit'] = 1000
        query['offset'] = offset
        response = requests.get(
            f'{URL}/rest/v1/{table}', headers=HEADERS, params=query, timeout=90)
        response.raise_for_status()
        batch = _loads(response.text)
        if not isinstance(batch, list):
            raise RuntimeError(f'{table} returned {batch!r}')
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


def season_ok(season):
    return bool(season) and all(c.isalnum() or c == '-' for c in season)


def build_payload(season, games):
    pitches = []
    for game in games:
        game_id = game['game_id']
        batch = fetch_all('pitches', {
            'select': ','.join(COLUMNS),
            'GameID': f'eq.{game_id}',
            'order': 'id.asc',
        })
        for row in batch:
            if row.get('GameID') != game_id:
                raise RuntimeError(f'pitch GameID {row.get("GameID")} != {game_id}')
            pitches.append(_compact(row, COLUMNS))
    return {
        'season': season,
        'games': [_compact(g, ['game_id', 'display_name', 'date', 'season', 'game_type']) for g in games],
        'pitches': pitches,
    }


def write_if_changed(season, payload):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f'{season}.json')
    body = _dumps({
        'season': payload['season'],
        'games': payload['games'],
        'pitches': payload['pitches'],
    })
    if os.path.exists(path):
        previous = _loads(open(path, encoding='utf-8').read())
        previous_body = _dumps({
            'season': previous.get('season'),
            'games': previous.get('games'),
            'pitches': previous.get('pitches'),
        })
        if previous_body == body:
            print(f'{season}: unchanged ({len(payload["pitches"])} pitches)')
            return
    stamped = _dumps({
        'season': payload['season'],
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'games': payload['games'],
        'pitches': payload['pitches'],
    })
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(stamped)
        handle.write('\n')
    print(f'{season}: wrote {path} ({len(payload["pitches"])} pitches, {os.path.getsize(path)} bytes)')


def main():
    if not URL or not KEY:
        print('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) are required')
        sys.exit(1)
    games = fetch_all('games', {
        'select': 'game_id,display_name,date,season,game_type',
        'order': 'date.asc,display_name.asc',
    })
    by_season = {}
    for game in games:
        season = game.get('season') or 'unknown'
        if not season_ok(season):
            raise RuntimeError(f'unexpected season name {season!r}')
        by_season.setdefault(season, []).append(game)
    if not by_season:
        print('no games')
        return
    for season in sorted(by_season):
        ordered = sorted(
            by_season[season],
            key=lambda g: (g.get('date') or '', g.get('display_name') or '', g.get('game_id') or ''),
        )
        write_if_changed(season, build_payload(season, ordered))


if __name__ == '__main__':
    main()
