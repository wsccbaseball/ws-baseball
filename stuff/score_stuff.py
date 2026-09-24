"""Nightly Stuff+ scoring (v5): grades any pitch in Supabase that doesn't have a grade yet.

v5 vs v4:
- Adds ArmAngle + pitcher-day FB diffs (dVelo_day, dIVB_day, dHB_day, dSpin_day)
- Loads stuff_{g}.txt and whiff_{g}.txt; 50/50 rv/whiff blend in z-space
- Primary FB is pitcher-level (highest-velo FB type with n>=10), matching training
"""
import os, json, sys
import numpy as np, pandas as pd, requests, lightgbm as lgb

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
NUM = ['RelSpeed', 'SpinRate', 'SpinAxis', 'InducedVertBreak', 'HorzBreak', 'RelHeight',
       'RelSide', 'Extension', 'VertApprAngle', 'HorzApprAngle']
REQUIRED = ['RelSpeed', 'SpinRate', 'SpinAxis', 'InducedVertBreak', 'HorzBreak', 'RelHeight', 'RelSide', 'Extension']


def load_boosters(prefix):
    loaded = {}
    for g in GROUPS:
        path = os.path.join(MODEL_DIR, f'{prefix}_{g}.txt')
        if not os.path.exists(path):
            if g == 'CT':
                continue
            raise FileNotFoundError(path)
        loaded[g] = lgb.Booster(model_file=path)
    return loaded


stuff_models = load_boosters('stuff')
whiff_models = load_boosters('whiff')
cfg = json.load(open(os.path.join(MODEL_DIR, 'scaling.json')))
FEATS = cfg['feats']
scale_rv = cfg.get('scale_rv') or cfg['scale']
scale_whiff = cfg['scale_whiff']
blend_w = cfg.get('blend_weights') or {'rv': 0.5, 'whiff': 0.5, 'swstr': 0.0}
W_RV = float(blend_w.get('rv', 0.5))
W_WHIFF = float(blend_w.get('whiff', 0.5))


def group_ready(g):
    return (g in stuff_models and g in whiff_models
            and bool(scale_rv.get(f'D1|{g}')) and bool(scale_rv.get(f'JUCO|{g}'))
            and bool(scale_whiff.get(f'D1|{g}')) and bool(scale_whiff.get(f'JUCO|{g}')))


def ct_block_reason():
    if 'CT' not in stuff_models or 'CT' not in whiff_models:
        return 'stuff/models/stuff_CT.txt or whiff_CT.txt is missing'
    missing = [k for k in ('D1|CT', 'JUCO|CT') if not scale_rv.get(k) or not scale_whiff.get(k)]
    if missing:
        return 'scaling.json is missing ' + ' and '.join(missing)
    return None


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


def fetch(params, page=1000):
    out, off = [], 0
    while True:
        p = dict(params, limit=page, offset=off)
        r = requests.get(f'{URL}/rest/v1/{TABLE}', headers=H, params=p, timeout=60)
        r.raise_for_status()
        b = r.json(); out += b
        if len(b) < page:
            return pd.DataFrame(out)
        off += page


def ptype(d):
    # Tagged first. Auto only when tagged blank/Undefined/Other. No Auto=Cutter override.
    tagged = d['TaggedPitchType']
    bad = tagged.isna() | tagged.isin(['Undefined', 'Other', ''])
    return tagged.where(~bad, d['AutoPitchType']).replace(CANON)


def pitcher_key(d):
    return (d['Pitcher'].fillna('').str.upper().str.replace(r'[^A-Z]', '', regex=True)
            + '_' + d['PitcherThrows'].str[0])


def build(d):
    """Feature eng matching stuff_plus_training_v5.py live/WS path."""
    d = d.copy()
    for c in NUM:
        if c in d.columns:
            d[c] = pd.to_numeric(d[c], errors='coerce')
    d['PType'] = ptype(d)
    d['PGroup'] = d['PType'].map(pitch_group)
    d = d[d['PGroup'].notna() & d['RelSpeed'].between(50, 110)
          & d['PitcherThrows'].isin(['Left', 'Right'])
          & d[REQUIRED].notna().all(axis=1)].copy()
    lhp = d['PitcherThrows'] == 'Left'
    for c in ['HorzBreak', 'RelSide', 'HorzApprAngle']:
        if c in d.columns:
            d.loc[lhp, c] = -d.loc[lhp, c]
    d.loc[lhp, 'SpinAxis'] = (360 - d.loc[lhp, 'SpinAxis']) % 360
    d['AxisSin'] = np.sin(np.radians(d['SpinAxis']))
    d['AxisCos'] = np.cos(np.radians(d['SpinAxis']))
    d['ArmAngle'] = np.degrees(np.arctan2(d['RelSide'].astype('float64'),
                                          d['RelHeight'].astype('float64')))
    d['Date'] = pd.to_datetime(d['Date'], errors='coerce')
    d['Key'] = pitcher_key(d)

    fb = d[d['PGroup'] == 'FB']
    agg = (fb.groupby(['Key', 'PType'])
             .agg(n=('RelSpeed', 'size'), v=('RelSpeed', 'mean'),
                  ivb=('InducedVertBreak', 'mean'), hb=('HorzBreak', 'mean')).reset_index())
    agg = agg[agg['n'] >= 10]
    prim = (agg.sort_values('v', ascending=False).drop_duplicates('Key')
              .set_index('Key')[['v', 'ivb', 'hb']])
    d = d.join(prim, on='Key')
    d['v'] = d['v'].fillna(d.groupby('Key')['RelSpeed'].transform('mean'))
    d['ivb'] = d['ivb'].fillna(d.groupby('Key')['InducedVertBreak'].transform('mean'))
    d['hb'] = d['hb'].fillna(d.groupby('Key')['HorzBreak'].transform('mean'))
    d['dVelo'] = d['RelSpeed'] - d['v']
    d['dIVB'] = d['InducedVertBreak'] - d['ivb']
    d['dHB'] = d['HorzBreak'] - d['hb']

    d['PitcherDay'] = d['Key'] + '_' + d['Date'].dt.strftime('%Y-%m-%d')
    fb_day = d[d['PGroup'] == 'FB']
    day_type = (fb_day.groupby(['PitcherDay', 'PType'])
                  .agg(n=('RelSpeed', 'size'), v=('RelSpeed', 'mean'),
                       ivb=('InducedVertBreak', 'mean'), hb=('HorzBreak', 'mean'),
                       spin=('SpinRate', 'mean')).reset_index())
    day_type = day_type.sort_values(['PitcherDay', 'n', 'v'], ascending=[True, False, False])
    day_prim = (day_type.drop_duplicates('PitcherDay').set_index('PitcherDay')
                .rename(columns={'v': 'v_day', 'ivb': 'ivb_day', 'hb': 'hb_day', 'spin': 'spin_day'}))
    d = d.join(day_prim[['v_day', 'ivb_day', 'hb_day', 'spin_day']], on='PitcherDay')
    d['dVelo_day'] = d['RelSpeed'] - d['v_day'].fillna(d['v'])
    d['dIVB_day'] = d['InducedVertBreak'] - d['ivb_day'].fillna(d['ivb'])
    d['dHB_day'] = d['HorzBreak'] - d['hb_day'].fillna(d['hb'])
    d['dSpin_day'] = d['SpinRate'] - d['spin_day'].fillna(
        d.groupby('Key')['SpinRate'].transform('mean'))
    return d


def score(d):
    d = d.copy()
    d['rv_pred'] = np.nan
    d['whiff_pred'] = np.nan
    for g, m in stuff_models.items():
        if not group_ready(g):
            continue
        i = d.index[d['PGroup'] == g]
        if len(i):
            d.loc[i, 'rv_pred'] = m.predict(d.loc[i, FEATS].astype(float))
    for g, m in whiff_models.items():
        if not group_ready(g):
            continue
        i = d.index[d['PGroup'] == g]
        if len(i):
            d.loc[i, 'whiff_pred'] = m.predict(d.loc[i, FEATS].astype(float))
    for lvl, col in [('JUCO', 'stuff_plus_juco'), ('D1', 'stuff_plus_d1')]:
        out = pd.Series(np.nan, index=d.index)
        for g in GROUPS:
            if not group_ready(g):
                continue
            sr = scale_rv[f'{lvl}|{g}']
            sw = scale_whiff[f'{lvl}|{g}']
            i = d.index[d['PGroup'] == g]
            z_rv = (sr['mean'] - d.loc[i, 'rv_pred']) / sr['sd']
            z_whiff = (d.loc[i, 'whiff_pred'] - sw['mean']) / sw['sd']
            out.loc[i] = 100 + 10 * (W_RV * z_rv + W_WHIFF * z_whiff)
        d[col] = out.round(1)
    return d


def main():
    if not URL or not KEY:
        print('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
        sys.exit(1)
    reason = ct_block_reason()
    if reason:
        print(f'Cutter model is not ready: {reason}. Cutter pitches will be left unscored.')
    pull = ['id', 'Pitcher', 'PitcherThrows', 'BatterSide', 'AutoPitchType', 'TaggedPitchType', 'Date'] + NUM
    unscored = fetch({'select': ','.join(pull), 'stuff_plus_juco': 'is.null'})
    print(f'{len(unscored)} unscored pitches')
    if unscored.empty:
        return
    # Baselines from all pitches so primary FB / day FB are stable
    all_pitches = fetch({'select': ','.join(pull)})
    built_all = build(all_pitches)
    built = built_all[built_all['id'].isin(set(unscored['id']))].copy()
    n_ct = int((built['PGroup'] == 'CT').sum())
    if n_ct and reason:
        print(f'Skipping {n_ct} cutter pitches this run (not scored as fastballs or breakers).')
        built = built[built['PGroup'] != 'CT']
    d = score(built)
    d = d[d['stuff_plus_juco'].notna()]
    print(f'{len(d)} gradeable (the rest are untracked or unknown pitch types)')
    rows = [{'id': int(i), 'j': float(j), 'd': float(x)}
            for i, j, x in zip(d['id'], d['stuff_plus_juco'], d['stuff_plus_d1'])]
    done = 0
    for k in range(0, len(rows), 2000):
        r = requests.post(f'{URL}/rest/v1/rpc/set_stuff_plus', headers=H,
                          json={'rows': rows[k:k+2000]}, timeout=120)
        if not r.ok:
            print(r.status_code, r.text); sys.exit(1)
        done += r.json()
    print(f'updated {done} rows')


if __name__ == '__main__':
    main()
