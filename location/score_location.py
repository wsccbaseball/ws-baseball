"""Location+ v1 and Pitching+ v1 scoring.

Location+ is plate location only. Pitching+ is a second-stage LightGBM. Its inputs
are a z-scored Stuff+ grade, a z-scored Location+ grade, the raw count, and platoon.
This script never writes stuff_plus_d1 or stuff_plus_juco.
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
        m = _load_booster(os.path.join(MODEL_DIR, f'location_{g}.txt'))
        if m is None:
            raise FileNotFoundError(os.path.join(MODEL_DIR, f'location_{g}.txt'))
        names = m.feature_name()
        if names != ['PlateLocHeight', 'PlateLocSide']:
            raise ValueError(f'location_{g}.txt features are {names}, expected PlateLocHeight PlateLocSide')
        loc[g] = m
        pm = _load_booster(os.path.join(MODEL_DIR, f'pitching_plus_v1_{g}.txt'))
        if pm is not None:
            if pm.feature_name() != PITCHING_FEATS:
                raise ValueError(f'pitching_plus_v1_{g}.txt features are {pm.feature_name()}')
            pit[g] = pm
    cfg_path = os.path.join(MODEL_DIR, 'pitching_plus_v1_scaling.json')
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(cfg_path)
    cfg = json.load(open(cfg_path))
    return loc, pit, cfg


loc_models, pit_models, cfg = load_models()
scale_location = cfg['scale_location']
scale_pitching = cfg['scale_pitching']
train_z = cfg['train_z']


def z100(grade, mean, sd):
    """Within-group grade to the 100 + 10z input the second stage was trained on."""
    return 100.0 + 10.0 * (np.asarray(grade, dtype=float) - mean) / sd


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


def _location_mask(d):
    return (d['PGroup'].notna()
            & d['loc_height'].notna()
            & d['loc_side'].notna()
            & d['PitcherThrows'].isin(['Left', 'Right']))


def _pitching_mask(d):
    # Batter side must be Right or Left. Do not treat a missing side as platoon 0.
    return (_location_mask(d)
            & d['location_plus_d1'].notna()
            & d['stuff_plus_d1'].notna()
            & d['Balls'].notna()
            & d['Strikes'].notna()
            & d['BatterSide'].isin(['Right', 'Left'])
            & d['PitcherThrows'].isin(['Right', 'Left']))


def score(df):
    """Fill null Location+ and Pitching+ grades. Stored Stuff+ is read and not changed."""
    d = prepare(df)
    need_loc = _location_mask(d) & d['location_plus_d1'].isna()
    for g, model in loc_models.items():
        key = f'D1|{g}'
        if key not in scale_location:
            continue
        i = d.index[need_loc & (d['PGroup'] == g)]
        if not len(i):
            continue
        X = pd.DataFrame({
            'PlateLocHeight': d.loc[i, 'loc_height'].to_numpy(dtype=float),
            'PlateLocSide': d.loc[i, 'loc_side'].to_numpy(dtype=float),
        })
        pred = model.predict(X)
        sc = scale_location[key]
        grade = 100.0 + 10.0 * (sc['mean'] - pred) / sc['sd']
        # Round before Pitching+ sees it, so the stored card grade is the input grade.
        d.loc[i, 'location_plus_d1'] = np.round(grade, 1)

    need_pit = _pitching_mask(d) & d['pitching_plus'].isna()
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


def rows_to_write(before, after):
    """Payload for set_location_pitching. Never includes Stuff+ columns."""
    rows = []
    for i in after.index:
        rec = {}
        if pd.isna(before.at[i, 'location_plus_d1']) and pd.notna(after.at[i, 'location_plus_d1']):
            rec['location_plus_d1'] = float(after.at[i, 'location_plus_d1'])
        if 'pitching_plus' in before.columns and pd.isna(before.at[i, 'pitching_plus']) and pd.notna(after.at[i, 'pitching_plus']):
            rec['pitching_plus'] = float(after.at[i, 'pitching_plus'])
        elif 'pitching_plus' not in before.columns and pd.notna(after.at[i, 'pitching_plus']):
            rec['pitching_plus'] = float(after.at[i, 'pitching_plus'])
        if not rec:
            continue
        rec['id'] = int(after.at[i, 'id'])
        rows.append(rec)
    return rows


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
    cols = ['id', 'PitcherThrows', 'BatterSide', 'AutoPitchType', 'TaggedPitchType',
            'PlateLocHeight', 'PlateLocSide', 'Balls', 'Strikes', 'stuff_plus_d1',
            'location_plus_d1', 'pitching_plus']
    # Null-fill only. A pitch that already has Location+ keeps that stored grade.
    pending = fetch({
        'select': ','.join(cols),
        'or': '(location_plus_d1.is.null,pitching_plus.is.null)',
    })
    print(f'{len(pending)} pitches missing Location+ or Pitching+')
    if pending.empty:
        return
    before = pending.copy()
    for c in ('location_plus_d1', 'pitching_plus', 'stuff_plus_d1'):
        before[c] = pd.to_numeric(before[c], errors='coerce')
    scored = score(before)
    rows = rows_to_write(before, scored)
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
