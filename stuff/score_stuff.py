"""Nightly Stuff+ scoring: grades any pitch in Supabase that doesn't have a grade yet."""
import os, json, sys
import numpy as np, pandas as pd, requests, lightgbm as lgb

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, 'models')
URL   = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY   = os.environ.get('SUPABASE_SERVICE_KEY', '')
TABLE = os.environ.get('STUFF_TABLE', 'pitches')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

# FB / CT / BB / OS. Cutter is its own group, never a fastball and never a breaker.
# CT aliases are the ones used elsewhere in this repo (pitcher-report.html).
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
# The model was trained only on pitches with all of these tracked. Grading a pitch
# with any of them missing is guesswork, so those pitches are left ungraded.
REQUIRED = ['RelSpeed', 'SpinRate', 'SpinAxis', 'InducedVertBreak', 'HorzBreak', 'RelHeight', 'RelSide', 'Extension']

def load_models():
    loaded = {}
    for g in GROUPS:
        path = os.path.join(MODEL_DIR, f'stuff_{g}.txt')
        # FB/BB/OS are the live models and must be present. CT is optional until
        # the cutter model is copied in from the Colab v3 retrain.
        if not os.path.exists(path):
            if g == 'CT':
                continue
            raise FileNotFoundError(path)
        loaded[g] = lgb.Booster(model_file=path)
    return loaded

models = load_models()
cfg = json.load(open(os.path.join(MODEL_DIR, 'scaling.json')))
scale, FEATS = cfg['scale'], cfg['feats']

def group_ready(g):
    """A group is scored only when its booster and both live scale keys exist."""
    return g in models and bool(scale.get(f'D1|{g}')) and bool(scale.get(f'JUCO|{g}'))

def ct_block_reason():
    if 'CT' not in models:
        return 'stuff/models/stuff_CT.txt is missing'
    missing = [k for k in ('D1|CT', 'JUCO|CT') if not scale.get(k)]
    if missing:
        return 'scaling.json is missing ' + ' and '.join(missing)
    return None

def pitch_group(s):
    try:
        if pd.isna(s):
            return None
    except (TypeError, ValueError):
        return None
    # CT first so a cutter alias can never fall through into FB.
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
        if len(b) < page: return pd.DataFrame(out)
        off += page

def season(dates):
    # '2026S' = spring (Jan-Jul), '2026F' = fall (Aug-Dec). Baselines never mix the two.
    dt = pd.to_datetime(dates, errors='coerce')
    return dt.dt.year.astype('Int64').astype(str) + np.where(dt.dt.month >= 8, 'F', 'S')

def key(d):
    return d['Pitcher'].fillna('').str.upper().str.replace(r'[^A-Z]', '', regex=True) \
           + '_' + d['PitcherThrows'].str[0]

def ptype(d):
    # Auto first. Tagged breakers are messy, so tagged is only the fallback when
    # auto is blank, Undefined, or Other.
    auto = d['AutoPitchType']
    bad = auto.isna() | auto.isin(['Undefined', 'Other', ''])
    return auto.where(~bad, d['TaggedPitchType']).replace(CANON)

def primary_fastball(a):
    """Highest-velo true fastball (10+ pitches) per pitcher-season. Cutters are excluded."""
    empty = pd.DataFrame(columns=['v', 'ivb', 'hb'],
                         index=pd.MultiIndex.from_arrays([[], []], names=['Key', 'Season']))
    fb = a[a['PType'].map(pitch_group) == 'FB']
    if fb.empty:
        return empty
    g = (fb.groupby(['Key', 'Season', 'PType'])
           .agg(n=('RelSpeed', 'size'), v=('RelSpeed', 'mean'),
                ivb=('InducedVertBreak', 'mean'), hb=('HorzBreak', 'mean')).reset_index())
    g = g[g['n'] >= 10]
    if g.empty:
        return empty
    return (g.sort_values('v', ascending=False).drop_duplicates(['Key', 'Season'])
             .set_index(['Key', 'Season'])[['v', 'ivb', 'hb']])

def baselines():
    a = fetch({'select': 'Pitcher,PitcherThrows,AutoPitchType,TaggedPitchType,Date,RelSpeed,InducedVertBreak,HorzBreak'})
    if a.empty:
        return pd.DataFrame(columns=['v', 'ivb', 'hb'], index=pd.MultiIndex.from_arrays([[], []], names=['Key', 'Season']))
    a = a[a['PitcherThrows'].isin(['Left', 'Right'])].copy()
    a['PType'] = ptype(a)
    for c in ['RelSpeed', 'InducedVertBreak', 'HorzBreak']:
        a[c] = pd.to_numeric(a[c], errors='coerce')
    a.loc[a['PitcherThrows'] == 'Left', 'HorzBreak'] *= -1
    a['Key'] = key(a)
    a['Season'] = season(a['Date'])
    return primary_fastball(a)

def build(d, base):
    d = d.copy()
    for c in NUM: d[c] = pd.to_numeric(d[c], errors='coerce')
    d['PType'] = ptype(d)
    d['PGroup'] = d['PType'].map(pitch_group)
    d = d[d['PGroup'].notna() & d['RelSpeed'].between(50, 110) & d['PitcherThrows'].isin(['Left', 'Right'])
          & d[REQUIRED].notna().all(axis=1)].copy()
    lhp = d['PitcherThrows'] == 'Left'
    for c in ['HorzBreak', 'RelSide', 'HorzApprAngle']:
        d.loc[lhp, c] = -d.loc[lhp, c]
    d.loc[lhp, 'SpinAxis'] = (360 - d.loc[lhp, 'SpinAxis']) % 360
    d['AxisSin'] = np.sin(np.radians(d['SpinAxis']))
    d['AxisCos'] = np.cos(np.radians(d['SpinAxis']))
    bs = d['BatterSide'].astype('object')
    d['Platoon'] = np.where(bs.isna() | ~bs.isin(['Left', 'Right']), np.nan,
                            ((bs == 'Left') != lhp).astype(float))
    d['Key'] = key(d)
    d['Season'] = season(d['Date'])
    d = d.join(base, on=['Key', 'Season'])
    d['dVelo'] = d['RelSpeed'] - d['v']
    d['dIVB']  = d['InducedVertBreak'] - d['ivb']
    d['dHB']   = d['HorzBreak'] - d['hb']
    return d

def score(d):
    d['rv_pred'] = np.nan
    for g, m in models.items():
        if not group_ready(g):
            continue
        i = d.index[d['PGroup'] == g]
        if len(i): d.loc[i, 'rv_pred'] = m.predict(d.loc[i, FEATS].astype(float))
    for lvl, col in [('JUCO', 'stuff_plus_juco'), ('D1', 'stuff_plus_d1')]:
        out = pd.Series(np.nan, index=d.index)
        for g in GROUPS:
            if not group_ready(g):
                continue
            s = scale[f'{lvl}|{g}']
            i = d.index[d['PGroup'] == g]
            out.loc[i] = 100 + 10 * (s['mean'] - d.loc[i, 'rv_pred']) / s['sd']
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
    new = fetch({'select': ','.join(pull), 'stuff_plus_juco': 'is.null'})
    print(f'{len(new)} unscored pitches')
    if new.empty: return
    built = build(new, baselines())
    n_ct = int((built['PGroup'] == 'CT').sum())
    if n_ct and reason:
        print(f'Skipping {n_ct} cutter pitches this run (not scored as fastballs or breakers).')
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
