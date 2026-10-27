"""Pitches with no GameID never get a public.games row.

TrackMan fielder-positioning exports land in public.pitches without a GameID
(PitcherTeam and BatterTeam can both be Wal_Sen). Scoring those rows writes
Stuff+ / Location+ / Pitching+ that the site cannot open, because games and
the season files are keyed by game_id. Callers skip them and log the skip.
"""


def game_id_missing(value):
    """True when GameID is null, NaN, or blank. A real id, including '0', is kept."""
    if value is None:
        return True
    if isinstance(value, float):
        return value != value
    if isinstance(value, str):
        return value.strip() == ''
    # pandas NA / NaT. str(pd.NA) is '<NA>', so the type check has to come first.
    if type(value).__name__ in ('NAType', 'NaTType'):
        return True
    return str(value).strip() == ''


def exclude_missing_game_id(frame):
    """Return (kept, skipped_count, skipped_ids).

    An empty frame is unchanged. A frame that cannot be checked raises
    KeyError so the scorer stops instead of grading every row.
    """
    if frame is None or len(frame) == 0:
        return frame, 0, []
    columns = frame.columns
    if 'GameID' not in columns or 'id' not in columns:
        raise KeyError('GameID' if 'GameID' not in columns else 'id')
    missing = frame['GameID'].map(game_id_missing)
    count = int(missing.sum())
    ids = []
    for value in frame.loc[missing, 'id'].tolist():
        if value is None or (isinstance(value, float) and value != value):
            continue
        ids.append(int(value))
    if not count:
        return frame, 0, []
    return frame.loc[~missing].copy(), count, ids


def log_null_game_id(count, example_ids, context, action='They are not scored and will not get a games row.'):
    """One grep-able line. count 0 prints nothing, so a normal night stays quiet."""
    if not count:
        return
    shown = list(example_ids)[:8]
    sample = ', '.join(str(i) for i in shown) if shown else 'none'
    extra_n = max(len(example_ids) - 8, 0)
    more = f' (+{extra_n} more)' if extra_n else ''
    print(
        f'SKIP null GameID: {count} {context} pitch(es) have no GameID. '
        f'{action} '
        f'Example ids: {sample}{more}'
    )
