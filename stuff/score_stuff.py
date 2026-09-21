"""Nightly Stuff+ scoring: grades any pitch in Supabase that doesn't have a grade yet."""
import os, json, sys
import numpy as np, pandas as pd, requests, lightgbm as lgb

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, 'models')
URL   = os.environ['SUPABASE_URL'].rstrip('/')
KEY   = os.environ['SUPABASE_SERVICE_KEY']
TABLE = os.environ.get('STUFF_TABLE', 'pitches')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

models = {g: lgb.Booster(model_file=os.path.join(MODEL_DIR, f'stuff_{g}.txt')) for g in ['FB','BB','OS']}
cfg = json.load(open(os.path.join(MODEL_DIR, 'scaling.json')))
scale, FEATS = cfg['scale'], cfg['feats']

FB  = {'Fastball','FourSeamFastBall','Four-Seam','TwoSeamFastBall','Sinker','Cutter'}
BB_ = {'Slider','Curveball','Sweeper','Slurve','Knuckleball'}
OS  = {'ChangeUp','Changeup','Splitter','Split-Finger','Screwball'}
CANON = {'Four-Seam':'Fastball','FourSeamFastBall':'Fastball','ChangeUp':'Changeup',
         'TwoSeamFastBall':'Sinker','Split-Finger':'Splitter'}
NUM = ['RelSpeed','SpinRate','SpinAxis','InducedVertBreak','HorzBreak','RelHeight',
       'RelSide','Extension','VertApprAngle','HorzApprAngle']

def pitch_group(s):
    return 'FB' if s in FB else 'BB' if s in BB_ else 'OS' if s in OS else None

def fetch(params, page=1000):
    out, off = [], 0
    while True:
        p = dict(params, limit=page, offset=off)
        r = requests.get(f'{URL}/rest/v1/{TABLE}', headers=H, params=p, timeout=60)
        r.raise_for_status()
        b = r.json(); out += b
        if len(b) < page: return pd.DataFrame(out)
        off += page

def key(d):
    return d['Pitcher'].fillna('').str.upper().str.replace(r'[^A-Z]', '', regex=True) \
           + '_' + d['PitcherThrows'].str[0]

def ptype(d):
    return d['AutoPitchType'].where(d['AutoPitchType'].notna(), d['TaggedPitchType']).replace(CANON)

def baselines():
    a = fetch({'select': 'Pitcher,PitcherThrows,AutoPitchType,TaggedPitchType,RelSpeed,InducedVertBreak,HorzBreak'})
    if a.empty: return pd.DataFrame(columns=['v','ivb','hb'])
    a = a[a['PitcherThrows'].isin(['Left','Right'])].copy()
    a['PType'] = ptype(a)
    for c in ['RelSpeed','InducedVertBreak','HorzBreak']:
        a[c] = pd.to_numeric(a[c], errors='coerce')
    a.loc[a['PitcherThrows'] == 'Left', 'HorzBreak'] *= -1
    a['Key'] = key(a)
    fb = a[a['PType'].map(pitch_group) == 'FB']
    g = (fb.groupby(['Key','PType'])
           .agg(n=('RelSpeed','size'), v=('RelSpeed','mean'),
                ivb=('InducedVertBreak','mean'), hb=('HorzBreak','mean')).reset_index())
    g = g[g['n'] >= 10]
    return g.sort_values('v', ascending=False).drop_duplicates('Key').set_index('Key')[['v','ivb','hb']]

def build(d, base):
    d = d.copy()
    for c in NUM: d[c] = pd.to_numeric(d[c], errors='coerce')
    d['PType'] = ptype(d)
    d['PGroup'] = d['PType'].map(pitch_group)
    d = d[d['PGroup'].notna() & d['RelSpeed'].between(50, 110) & d['PitcherThrows'].isin(['Left','Right'])].copy()
    lhp = d['PitcherThrows'] == 'Left'
    for c in ['HorzBreak','RelSide','HorzApprAngle']:
        d.loc[lhp, c] = -d.loc[lhp, c]
    d.loc[lhp, 'SpinAxis'] = (360 - d.loc[lhp, 'SpinAxis']) % 360
    d['AxisSin'] = np.sin(np.radians(d['SpinAxis']))
    d['AxisCos'] = np.cos(np.radians(d['SpinAxis']))
    bs = d['BatterSide'].astype('object')
    d['Platoon'] = np.where(bs.isna() | ~bs.isin(['Left','Right']), np.nan,
                            ((bs == 'Left') != lhp).astype(float))
    d['Key'] = key(d)
    d = d.join(base, on='Key')
    d['dVelo'] = d['RelSpeed'] - d['v']
    d['dIVB']  = d['InducedVertBreak'] - d['ivb']
    d['dHB']   = d['HorzBreak'] - d['hb']
    return d

def score(d):
    d['rv_pred'] = np.nan
    for g, m in models.items():
        i = d.index[d['PGroup'] == g]
        if len(i): d.loc[i, 'rv_pred'] = m.predict(d.loc[i, FEATS].astype(float))
    for lvl, col in [('JUCO','stuff_plus_juco'), ('D1','stuff_plus_d1')]:
        out = pd.Series(np.nan, index=d.index)
        for g in ['FB','BB','OS']:
            s = scale.get(f'{lvl}|{g}')
            if not s: continue
            i = d.index[d['PGroup'] == g]
            out.loc[i] = 100 + 10 * (s['mean'] - d.loc[i, 'rv_pred']) / s['sd']
        d[col] = out.round(1)
    return d

def main():
    pull = ['id','Pitcher','PitcherThrows','BatterSide','AutoPitchType','TaggedPitchType'] + NUM
    new = fetch({'select': ','.join(pull), 'stuff_plus_juco': 'is.null'})
    print(f'{len(new)} unscored pitches')
    if new.empty: return
    d = score(build(new, baselines()))
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
