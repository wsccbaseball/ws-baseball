"""Location+ v3 and Pitching+ v1 scoring.

Location+ v3 predicts expected run value from plate location and the count
(PlateLocHeight, PlateLocSide, Balls, Strikes), then converts that to a
count-neutral grade. Pitching+ is still the v1 second-stage LightGBM. Its
inputs are a z-scored Stuff+ grade, a z-scored Location+ grade, the raw count,
and platoon. This script never writes stuff_plus_d1 or stuff_plus_juco.

Nightly runs fill null grades only. LOCATION_RESCORE=1 rewrites every gradeable
Location+ and every Pitching+ that can be computed from it. The first deploy
needs that manual pass; swapping the boosters does not change stored grades.
"""
import os
import json
import sys

import numpy as np
import pandas as pd
import requests
import lightgbm as lgb

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, 'models')
URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
TABLE = os.environ.get('STUFF_TABLE', 'pitches')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

GROUPS = ('FB', 'CT', 'BB', 'OS')
LOC_FEATS = ['PlateLocHeight', 'PlateLocSide', 'Balls', 'Strikes']
PITCH_GROUPS = {
    'FB': {'Fastball', 'FourSeamFastBall', 'Four-Seam', 'TwoSeamFastBall', 'Sinker'},
    'CT': {'Cutter', 'Cut Fastball', 'FC', 'CT'},
    'BB': {'Slider', 'Curveball', 'Sweeper', 'Slurve', 'Knuckleball'},
    'OS': {'ChangeUp', 'Changeup', 'Splitter', 'Split-Finger', 'Screwball'},
}
CANON = {'Four-Seam': 'Fastball', 'FourSeamFastBall': 'Fastball', 'ChangeUp': 'Changeup',
         'TwoSeamFastBall': 'Sinker', 'Split-Finger': 'Splitter',
         'Cut Fastball': 'Cutter', 'FC': 'Cutter', 'CT': 'Cutter'}
PITCHING_FEATS = ['StuffZ100', 'LocationZ100', 'Balls', 'Strikes', 'Platoon']
SELECT_COLS = ['id', 'PitcherThrows', 'BatterSide', 'AutoPitchType', 'TaggedPitchType',
               'PlateLocHeight', 'PlateLocSide', 'Balls', 'Strikes', 'stuff_plus_d1',
               'location_plus_d1', 'pitching_plus']
MIN_GRADE_N = 100  # card display only; scoring still writes every gradeable pitch


def pitch_group(s):
    try:
        if pd.isna(s):
            return None
    except (TypeError, ValueError):
        return None
    for g in ('CT', 'FB', 'BB', 'OS'):
        if s in PITCH_GROUPS[g]:
            return g
    return None


def ptype(d):
    # Tagged first. Auto only when tagged is blank, Undefined, or Other.
    tagged = d['TaggedPitchType']
    bad = tagged.isna() | tagged.isin(['Undefined', 'Other', ''])
    return tagged.where(~bad, d['AutoPitchType']).replace(CANON)


def _load_booster(path):
    if not os.path.exists(path):
        return None
    return lgb.Booster(model_file=path)


def load_models():
    loc, pit = {}, {}
    for g in GROUPS:
        path = os.path.join(MODEL_DIR, f'location_{g}.txt')
        m = _load_booster(path)
        if m is None:
            raise FileNotFoundError(path)
        names = m.feature_name()
        if names != LOC_FEATS:
            raise ValueError(f'location_{g}.txt features are {names}, expected {LOC_FEATS}')
        loc[g] = m
        pm = _load_booster(os.path.join(MODEL_DIR, f'pitching_plus_v1_{g}.txt'))
        if pm is not None:
            if pm.feature_name() != PITCHING_FEATS:
                raise ValueError(f'pitching_plus_v1_{g}.txt features are {pm.feature_name()}')
            pit[g] = pm
    cfg_path = os.path.join(MODEL_DIR, 'pitching_plus_v1_scaling.json')
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(cfg_path)
    with open(cfg_path) as handle:
        cfg = json.load(handle)
    loc_path = os.path.join(MODEL_DIR, 'location_scaling.json')
    if not os.path.exists(loc_path):
        raise FileNotFoundError(loc_path)
    with open(loc_path) as handle:
        loc_cfg = json.load(handle)
    if loc_cfg.get('feats') != LOC_FEATS:
        raise ValueError(f'location_scaling.json feats are {loc_cfg.get("feats")}')
    refs = loc_cfg.get('grade_refs') or {}
    for key in ('ref_rv', 'rv_sd', 'c_mu', 'c_sd', 'w_rv'):
        if key not in refs:
            raise ValueError(f'location_scaling.json grade_refs missing {key}')
    if float(refs['w_rv']) != 1.0:
        raise ValueError('Location+ v3 scoring is direct RV only; w_rv must be 1.0')
    if 'kappa' not in (loc_cfg.get('shrinkage') or {}):
        raise ValueError('location_scaling.json shrinkage.kappa is missing')
    return loc, pit, cfg, loc_cfg


loc_models, pit_models, cfg, loc_cfg = load_models()
grade_refs = loc_cfg['grade_refs']
SHRINK_KAPPA = float(loc_cfg['shrinkage']['kappa'])
scale_pitching = cfg['scale_pitching']
train_z = cfg['train_z']


def z100(grade, mean, sd):
    """Within-group grade to the 100 + 10z input the second stage was trained on."""
    return 100.0 + 10.0 * (np.asarray(grade, dtype=float) - mean) / sd


def location_plus_from_pred(pred, group, balls, strikes):
    """One unshrunk pitch grade. Same number as Colab LocationPlus_raw.

    Count-neutral quality is the count reference minus predicted run value, so a
    pitch that is better than that count (lower expected RV) grades above 100.
    w_rv is 1, so Strike+ is not blended in.
    """
    return float(location_plus_array([pred], group, [balls], [strikes])[0])


def location_plus_array(pred, group, balls, strikes):
    pred = np.asarray(pred, dtype=float)
    balls = np.asarray(balls, dtype=float)
    strikes = np.asarray(strikes, dtype=float)
    ref_map = grade_refs['ref_rv']
    ref = np.array([
        ref_map.get(f'{group}|{int(b)}|{int(s)}', np.nan)
        for b, s in zip(balls, strikes)
    ], dtype=float)
    # Colab apply_grades: q_rv = -(xRV - ref) = ref - pred.
    q_rv = ref - pred
    c = q_rv / float(grade_refs['rv_sd'])
    grade = 100.0 + 10.0 * (c - float(grade_refs['c_mu'])) / float(grade_refs['c_sd'])
    grade[~np.isfinite(ref) | ~np.isfinite(pred)] = np.nan
    return grade


def shrink_pitcher_mean(raw_mean, n, kappa=None):
    """Staff-board shrink of a pitcher's unshrunk mean. Not stored on pitches.

    shrunk = 100 + n/(n+kappa) * (raw_mean - 100). The season card does not
    average Location+ today, so this is unused by the nightly job.
    """
    if kappa is None:
        kappa = SHRINK_KAPPA
    n = float(n)
    k = float(kappa)
    if not np.isfinite(n) or not np.isfinite(k) or n < 0 or k < 0 or (n + k) == 0:
        return np.nan
    return 100.0 + n / (n + k) * (float(raw_mean) - 100.0)


def prepare(df):
    d = df.copy()
    for c in ('PlateLocHeight', 'PlateLocSide', 'Balls', 'Strikes', 'stuff_plus_d1',
              'location_plus_d1', 'pitching_plus'):
        if c in d.columns:
            d[c] = pd.to_numeric(d[c], errors='coerce')
        elif c in ('location_plus_d1', 'pitching_plus', 'stuff_plus_d1', 'Balls', 'Strikes'):
            d[c] = np.nan
    d['PType'] = ptype(d)
    d['PGroup'] = d['PType'].map(pitch_group)
    # Flip side only, the same way Stuff+ flips RelSide. Height stays put.
    d['loc_height'] = d['PlateLocHeight']
    d['loc_side'] = d['PlateLocSide']
    lhp = d['PitcherThrows'] == 'Left'
    d.loc[lhp, 'loc_side'] = -d.loc[lhp, 'loc_side']
    return d


def _whole_count(series, lo, hi):
    v = pd.to_numeric(series, errors='coerce')
    whole = v.notna() & (np.floor(v) == v)
    return whole & v.between(lo, hi)


def _location_mask(d):
    # Balls 0-3 and strikes 0-2 are required. Out-of-range counts are not clipped.
    return (d['PGroup'].notna()
            & d['loc_height'].notna()
            & d['loc_side'].notna()
            & d['PitcherThrows'].isin(['Left', 'Right'])
            & _whole_count(d['Balls'], 0, 3)
            & _whole_count(d['Strikes'], 0, 2))


def _pitching_inputs_mask(d):
    """Pitching+ inputs. Count may sit outside the Location+ v3 range.

    Plate location, group, and hand still have to be present, matching the v1
    blanking rule. Batter side must be Right or Left. A missing side is not platoon 0.
    A 4-ball count is scored only when Location+ is already stored, because v3
    will not invent a location grade for that count.
    """
    return (d['PGroup'].notna()
            & d['loc_height'].notna()
            & d['loc_side'].notna()
            & d['PitcherThrows'].isin(['Left', 'Right'])
            & d['location_plus_d1'].notna()
            & d['stuff_plus_d1'].notna()
            & d['Balls'].notna()
            & d['Strikes'].notna()
            & d['BatterSide'].isin(['Right', 'Left']))


def score(df, rescore=False):
    """Fill Location+ and Pitching+. Stored Stuff+ is read and not changed.

    rescore=False fills nulls only. rescore=True rewrites every gradeable
    Location+ and every Pitching+ with the inputs the second stage needs.
    """
    d = prepare(df)
    loc_ok = _location_mask(d)
    need_loc = loc_ok if rescore else (loc_ok & d['location_plus_d1'].isna())
    for g, model in loc_models.items():
        i = d.index[need_loc & (d['PGroup'] == g)]
        if not len(i):
            continue
        X = pd.DataFrame({
            'PlateLocHeight': d.loc[i, 'loc_height'].to_numpy(dtype=float),
            'PlateLocSide': d.loc[i, 'loc_side'].to_numpy(dtype=float),
            'Balls': d.loc[i, 'Balls'].to_numpy(dtype=float),
            'Strikes': d.loc[i, 'Strikes'].to_numpy(dtype=float),
        })
        pred = model.predict(X)
        grades = location_plus_array(pred, g, d.loc[i, 'Balls'], d.loc[i, 'Strikes'])
        ok = np.isfinite(grades)
        if not ok.any():
            continue
        d.loc[i[ok], 'location_plus_d1'] = np.round(grades[ok], 1)

    # Pitching+ still accepts a raw count outside 0-3 / 0-2 when Location+ is
    # already on the row. A new Location+ grade is only written inside that range.
    pit_ok = _pitching_inputs_mask(d)
    need_pit = pit_ok if rescore else (pit_ok & d['pitching_plus'].isna())
    for g, model in pit_models.items():
        if g not in scale_pitching or g not in train_z:
            continue
        i = d.index[need_pit & (d['PGroup'] == g)]
        if not len(i):
            continue
        tz = train_z[g]
        stuff_z = z100(d.loc[i, 'stuff_plus_d1'], tz['stuff_grade_mean'], tz['stuff_grade_sd'])
        loc_z = z100(d.loc[i, 'location_plus_d1'], tz['location_grade_mean'], tz['location_grade_sd'])
        platoon = (d.loc[i, 'BatterSide'].to_numpy() == d.loc[i, 'PitcherThrows'].to_numpy()).astype(float)
        X = pd.DataFrame({
            'StuffZ100': np.asarray(stuff_z, dtype=float),
            'LocationZ100': np.asarray(loc_z, dtype=float),
            'Balls': d.loc[i, 'Balls'].to_numpy(dtype=float),
            'Strikes': d.loc[i, 'Strikes'].to_numpy(dtype=float),
            'Platoon': platoon,
        })
        pred = model.predict(X)
        sc = scale_pitching[g]
        grade = 100.0 + 10.0 * (sc['mean'] - pred) / sc['sd']
        d.loc[i, 'pitching_plus'] = np.round(grade, 1)
    return d


def _changed(before_val, after_val, rescore):
    if pd.isna(after_val):
        return False
    if not rescore:
        return pd.isna(before_val)
    if pd.isna(before_val):
        return True
    return round(float(before_val), 1) != round(float(after_val), 1)


def rows_to_write(before, after, rescore=False):
    """Payload for set_location_pitching. Never includes Stuff+ columns."""
    rows = []
    for i in after.index:
        rec = {}
        loc_before = before.at[i, 'location_plus_d1'] if 'location_plus_d1' in before.columns else np.nan
        if _changed(loc_before, after.at[i, 'location_plus_d1'], rescore):
            rec['location_plus_d1'] = float(after.at[i, 'location_plus_d1'])
        if 'pitching_plus' in before.columns:
            pit_before = before.at[i, 'pitching_plus']
        else:
            pit_before = np.nan
        if _changed(pit_before, after.at[i, 'pitching_plus'], rescore or 'pitching_plus' not in before.columns):
            rec['pitching_plus'] = float(after.at[i, 'pitching_plus'])
        if not rec:
            continue
        rec['id'] = int(after.at[i, 'id'])
        rows.append(rec)
    return rows


def rescore_requested():
    """True when LOCATION_RESCORE is 1, true, or yes. Unset and 0 stay null-fill."""
    return os.environ.get('LOCATION_RESCORE', '').strip().lower() in {'1', 'true', 'yes'}


def fetch(params, page=1000):
    out, off = [], 0
    while True:
        p = dict(params, limit=page, offset=off)
        r = requests.get(f'{URL}/rest/v1/{TABLE}', headers=H, params=p, timeout=60)
        r.raise_for_status()
        b = r.json()
        out += b
        if len(b) < page:
            return pd.DataFrame(out)
        off += page


def main():
    if not URL or not KEY:
        print('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
        sys.exit(1)
    missing = [g for g in GROUPS if g not in pit_models]
    if missing:
        print('Pitching+ boosters missing for ' + ', '.join(missing) + '. Those pitches stay blank.')
    rescore = rescore_requested()
    params = {'select': ','.join(SELECT_COLS)}
    if rescore:
        print('LOCATION_RESCORE=1: rewriting every gradeable Location+ and Pitching+')
    else:
        # Null-fill only. A pitch that already has Location+ keeps that stored grade.
        params['or'] = '(location_plus_d1.is.null,pitching_plus.is.null)'
    pending = fetch(params)
    if rescore:
        print(f'{len(pending)} pitches loaded for Location+ rescore')
    else:
        print(f'{len(pending)} pitches missing Location+ or Pitching+')
    if pending.empty:
        return
    before = pending.copy()
    for c in ('location_plus_d1', 'pitching_plus', 'stuff_plus_d1'):
        before[c] = pd.to_numeric(before[c], errors='coerce')
    scored = score(before, rescore=rescore)
    rows = rows_to_write(before, scored, rescore=rescore)
    print(f'{len(rows)} pitches to write')
    if not rows:
        return
    done = 0
    for k in range(0, len(rows), 2000):
        r = requests.post(f'{URL}/rest/v1/rpc/set_location_pitching', headers=H,
                          json={'rows': rows[k:k + 2000]}, timeout=120)
        if not r.ok:
            print(r.status_code, r.text)
            sys.exit(1)
        done += r.json()
    print(f'updated {done} rows')


if __name__ == '__main__':
    main()
