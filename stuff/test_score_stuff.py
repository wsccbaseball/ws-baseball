"""Group, typing, and CT-skip tests for score_stuff. No network and no fake model file."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score_stuff as s


def _pitch(**kw):
    row = dict(
        Pitcher='Ace', PitcherThrows='Right', BatterSide='Right',
        AutoPitchType='Fastball', TaggedPitchType='Fastball', Date='2026-03-01',
        RelSpeed=93, SpinRate=2300, SpinAxis=200, InducedVertBreak=18, HorzBreak=10,
        RelHeight=5.6, RelSide=1.1, Extension=6.1, VertApprAngle=-5, HorzApprAngle=1,
    )
    row.update(kw)
    return row


class PitchGroupTests(unittest.TestCase):
    def test_cutter_aliases_are_ct_not_fb_or_bb(self):
        for name in ('Cutter', 'Cut Fastball', 'FC', 'CT'):
            self.assertEqual(s.pitch_group(name), 'CT', name)
        for name in ('Fastball', 'FourSeamFastBall', 'Four-Seam', 'TwoSeamFastBall', 'Sinker'):
            self.assertEqual(s.pitch_group(name), 'FB', name)
        self.assertEqual(s.pitch_group('Slider'), 'BB')
        self.assertEqual(s.pitch_group('ChangeUp'), 'OS')
        self.assertIsNone(s.pitch_group('Other'))
        self.assertIsNone(s.pitch_group(None))

    def test_tagged_first_then_canon_no_auto_cutter_override(self):
        d = pd.DataFrame([
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType=None, TaggedPitchType='Cutter'),
            _pitch(AutoPitchType='Undefined', TaggedPitchType='Slider'),
            _pitch(AutoPitchType='Other', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType='', TaggedPitchType='Sinker'),
            _pitch(AutoPitchType='Four-Seam', TaggedPitchType='Sinker'),
            _pitch(AutoPitchType='ChangeUp', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType='Slider', TaggedPitchType='Cutter'),
            _pitch(AutoPitchType='FC', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType='Cut Fastball', TaggedPitchType='Slider'),
            # Tagged missing: auto is the fallback, then CANON. Auto cutter is
            # CT only in that case, not because of an override.
            _pitch(AutoPitchType='Cutter', TaggedPitchType=None),
            _pitch(AutoPitchType='Cutter', TaggedPitchType=''),
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Undefined'),
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Other'),
            _pitch(AutoPitchType='Four-Seam', TaggedPitchType=None),
            _pitch(AutoPitchType='FC', TaggedPitchType='Undefined'),
            _pitch(AutoPitchType='ChangeUp', TaggedPitchType='Other'),
            _pitch(AutoPitchType='Cut Fastball', TaggedPitchType=''),
        ])
        got = list(s.ptype(d))
        self.assertEqual(got, [
            'Fastball', 'Cutter', 'Slider', 'Fastball', 'Sinker',
            'Sinker', 'Fastball', 'Cutter', 'Fastball', 'Slider',
            'Cutter', 'Cutter', 'Cutter', 'Cutter',
            'Fastball', 'Cutter', 'Changeup', 'Cutter',
        ])
        self.assertEqual(s.pitch_group(got[0]), 'FB')
        self.assertEqual(s.pitch_group(got[7]), 'CT')
        self.assertEqual(s.pitch_group(got[10]), 'CT')

    def test_primary_fastball_ignores_harder_cutter(self):
        rows = []
        for _ in range(12):
            rows.append(_pitch(TaggedPitchType='Cutter', AutoPitchType='Cutter', RelSpeed=96,
                               InducedVertBreak=8, HorzBreak=3))
            rows.append(_pitch(TaggedPitchType='Fastball', RelSpeed=91,
                               InducedVertBreak=17, HorzBreak=9))
        d = s.build(pd.DataFrame(rows))
        fb = d[d['PType'] == 'Fastball'].iloc[0]
        self.assertAlmostEqual(fb['v'], 91)
        self.assertAlmostEqual(fb['ivb'], 17)
        self.assertAlmostEqual(fb['hb'], 9)
        ct = d[d['PType'] == 'Cutter'].iloc[0]
        self.assertAlmostEqual(ct['dVelo'], 5)

    def test_fewer_than_10_fastballs_does_not_use_cutter_as_primary(self):
        rows = [_pitch(TaggedPitchType='Cutter', RelSpeed=80, InducedVertBreak=8, HorzBreak=2)
                for _ in range(15)]
        rows += [_pitch(TaggedPitchType='Fastball', RelSpeed=100, InducedVertBreak=16, HorzBreak=8)
                 for _ in range(9)]
        d = s.build(pd.DataFrame(rows))
        # No FB type reaches n>=10, so the baseline is the pitcher mean, not the cutter.
        expected = (15 * 80 + 9 * 100) / 24
        self.assertAlmostEqual(d['v'].iloc[0], expected)
        self.assertNotAlmostEqual(d['v'].iloc[0], 80)

    def test_build_routes_groups_and_diffs_against_true_fb(self):
        rows = [
            _pitch(AutoPitchType='Sinker', TaggedPitchType='Four-Seam', RelSpeed=92,
                   InducedVertBreak=16, HorzBreak=8)
            for _ in range(12)
        ]
        rows += [
            # Tagged Cutter stays CT even when auto says Fastball.
            _pitch(AutoPitchType='Fastball', TaggedPitchType='Cutter', RelSpeed=88,
                   InducedVertBreak=8, HorzBreak=4),
            # Auto Cutter does not pull a tagged slider into CT.
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Slider', RelSpeed=84,
                   InducedVertBreak=2, HorzBreak=6),
            _pitch(AutoPitchType='Fastball', TaggedPitchType='ChangeUp', RelSpeed=83,
                   InducedVertBreak=6, HorzBreak=12),
        ]
        d = s.build(pd.DataFrame(rows))
        fb = d[d['PType'] == 'Fastball'].iloc[0]
        ct = d[d['PType'] == 'Cutter'].iloc[0]
        bb = d[d['PType'] == 'Slider'].iloc[0]
        os_ = d[d['PType'] == 'Changeup'].iloc[0]
        self.assertEqual(fb['PGroup'], 'FB')
        self.assertEqual(ct['PGroup'], 'CT')
        self.assertEqual(bb['PGroup'], 'BB')
        self.assertEqual(os_['PGroup'], 'OS')
        self.assertAlmostEqual(fb['dVelo'], 0)
        self.assertAlmostEqual(ct['dVelo'], -4)
        self.assertAlmostEqual(ct['dIVB'], -8)
        self.assertAlmostEqual(ct['dHB'], -4)
        self.assertAlmostEqual(os_['dVelo'], -9)
        # Same outing: day diffs use that day's most-used FB type.
        self.assertAlmostEqual(ct['dVelo_day'], -4)
        self.assertAlmostEqual(ct['dSpin_day'], 0)

    def test_day_fb_is_most_used_then_higher_velo(self):
        rows = []
        for _ in range(12):
            rows.append(_pitch(TaggedPitchType='Sinker', RelSpeed=90, InducedVertBreak=10, HorzBreak=14,
                               SpinRate=2100, Date='2026-03-01'))
        for _ in range(6):
            rows.append(_pitch(TaggedPitchType='Fastball', RelSpeed=95, InducedVertBreak=18, HorzBreak=8,
                               SpinRate=2400, Date='2026-03-01'))
        rows.append(_pitch(TaggedPitchType='Slider', RelSpeed=82, InducedVertBreak=2, HorzBreak=4,
                           SpinRate=2500, Date='2026-03-01'))
        d = s.build(pd.DataFrame(rows))
        slider = d[d['PType'] == 'Slider'].iloc[0]
        # Sinker has n=12; the harder Fastball has only 6, so the pitcher baseline is the sinker.
        self.assertAlmostEqual(slider['v'], 90)
        self.assertAlmostEqual(slider['dVelo'], -8)
        # Day FB is the most-used type (Sinker, n=12), not the harder four-seam.
        self.assertAlmostEqual(slider['v_day'], 90)
        self.assertAlmostEqual(slider['dVelo_day'], -8)
        self.assertAlmostEqual(slider['dIVB_day'], -8)
        self.assertAlmostEqual(slider['dHB_day'], -10)
        self.assertAlmostEqual(slider['dSpin_day'], 400)

    def test_lhp_flips_break_and_arm_angle(self):
        rows = [_pitch(PitcherThrows='Left', RelSide=1.5, RelHeight=6.0, HorzBreak=10,
                       SpinAxis=200, TaggedPitchType='Fastball', RelSpeed=92)
                for _ in range(10)]
        d = s.build(pd.DataFrame(rows))
        row = d.iloc[0]
        self.assertAlmostEqual(row['HorzBreak'], -10)
        self.assertAlmostEqual(row['RelSide'], -1.5)
        self.assertAlmostEqual(row['SpinAxis'], (360 - 200) % 360)
        self.assertAlmostEqual(row['ArmAngle'], float(np.degrees(np.arctan2(-1.5, 6.0))))


def _blend(rv, whiff, sr, sw):
    z = s.W_RV * (sr['mean'] - rv) / sr['sd'] + s.W_WHIFF * (whiff - sw['mean']) / sw['sd']
    return round(100 + 10 * z, 1)


class ScoreTests(unittest.TestCase):
    def _frame(self):
        feats = {f: 0.0 for f in s.FEATS}
        feats.update(RelSpeed=92, SpinRate=2200, InducedVertBreak=16, HorzBreak=8,
                     AxisSin=0.2, AxisCos=0.9, RelHeight=5.5, RelSide=1.2, Extension=6.0)
        fb = dict(feats, PGroup='FB')
        ct = dict(feats, PGroup='CT')
        return pd.DataFrame([fb, ct])

    def test_installed_models_share_feats_and_score_ct(self):
        want = ['RelSpeed', 'SpinRate', 'InducedVertBreak', 'HorzBreak', 'AxisSin', 'AxisCos',
                'RelHeight', 'RelSide', 'Extension', 'dVelo', 'dIVB', 'dHB',
                'ArmAngle', 'dVelo_day', 'dIVB_day', 'dHB_day', 'dSpin_day']
        self.assertEqual(list(s.FEATS), want)
        self.assertEqual(len(s.FEATS), 17)
        for g in ('FB', 'BB', 'OS', 'CT'):
            self.assertIn(g, s.stuff_models)
            self.assertIn(g, s.whiff_models)
            self.assertEqual(s.stuff_models[g].feature_name(), want)
            self.assertEqual(s.whiff_models[g].feature_name(), want)
            for lvl in ('D1', 'JUCO'):
                self.assertGreater(s.scale_rv[f'{lvl}|{g}']['sd'], 0)
                self.assertGreater(s.scale_whiff[f'{lvl}|{g}']['sd'], 0)
        self.assertIsNone(s.ct_block_reason())
        self.assertTrue(s.group_ready('CT'))
        d = s.score(self._frame())
        rv = float(d.loc[1, 'rv_pred'])
        wh = float(d.loc[1, 'whiff_pred'])
        self.assertAlmostEqual(d.loc[1, 'stuff_plus_juco'], _blend(rv, wh, s.scale_rv['JUCO|CT'], s.scale_whiff['JUCO|CT']))
        self.assertAlmostEqual(d.loc[1, 'stuff_plus_d1'], _blend(rv, wh, s.scale_rv['D1|CT'], s.scale_whiff['D1|CT']))
        fb_only = _blend(rv, wh, s.scale_rv['JUCO|FB'], s.scale_whiff['JUCO|FB'])
        self.assertNotAlmostEqual(d.loc[1, 'stuff_plus_juco'], fb_only)

    def test_missing_ct_model_does_not_score_cutters_as_fb(self):
        saved_stuff = dict(s.stuff_models)
        saved_whiff = dict(s.whiff_models)
        saved_rv = dict(s.scale_rv)
        saved_wh = dict(s.scale_whiff)
        try:
            s.stuff_models.pop('CT', None)
            s.whiff_models.pop('CT', None)
            s.scale_rv.pop('D1|CT', None)
            s.scale_rv.pop('JUCO|CT', None)
            s.scale_whiff.pop('D1|CT', None)
            s.scale_whiff.pop('JUCO|CT', None)
            self.assertIsNotNone(s.ct_block_reason())
            self.assertFalse(s.group_ready('CT'))
            self.assertTrue(s.group_ready('FB'))
            d = s.score(self._frame())
            self.assertTrue(pd.notna(d.loc[0, 'stuff_plus_juco']))
            self.assertTrue(pd.notna(d.loc[0, 'stuff_plus_d1']))
            self.assertTrue(pd.isna(d.loc[1, 'stuff_plus_juco']))
            self.assertTrue(pd.isna(d.loc[1, 'stuff_plus_d1']))
            self.assertTrue(pd.isna(d.loc[1, 'rv_pred']))
            self.assertTrue(pd.isna(d.loc[1, 'whiff_pred']))
        finally:
            s.stuff_models.clear(); s.stuff_models.update(saved_stuff)
            s.whiff_models.clear(); s.whiff_models.update(saved_whiff)
            s.scale_rv.clear(); s.scale_rv.update(saved_rv)
            s.scale_whiff.clear(); s.scale_whiff.update(saved_wh)

    def test_ct_scale_keys_are_used_when_present(self):
        saved_stuff = dict(s.stuff_models)
        saved_whiff = dict(s.whiff_models)
        saved_rv = dict(s.scale_rv)
        saved_wh = dict(s.scale_whiff)
        try:
            s.stuff_models['CT'] = s.stuff_models['FB']
            s.whiff_models['CT'] = s.whiff_models['FB']
            s.scale_rv['D1|CT'] = {'mean': 0.02, 'sd': 0.01}
            s.scale_rv['JUCO|CT'] = {'mean': 0.03, 'sd': 0.02}
            s.scale_whiff['D1|CT'] = {'mean': 0.20, 'sd': 0.05}
            s.scale_whiff['JUCO|CT'] = {'mean': 0.25, 'sd': 0.04}
            self.assertIsNone(s.ct_block_reason())
            d = s.score(self._frame())
            rv = float(d.loc[1, 'rv_pred'])
            wh = float(d.loc[1, 'whiff_pred'])
            self.assertAlmostEqual(d.loc[1, 'stuff_plus_juco'], _blend(rv, wh, s.scale_rv['JUCO|CT'], s.scale_whiff['JUCO|CT']))
            self.assertAlmostEqual(d.loc[1, 'stuff_plus_d1'], _blend(rv, wh, s.scale_rv['D1|CT'], s.scale_whiff['D1|CT']))
            fb_as_fb = _blend(rv, wh, s.scale_rv['JUCO|FB'], s.scale_whiff['JUCO|FB'])
            self.assertNotAlmostEqual(d.loc[1, 'stuff_plus_juco'], fb_as_fb)
            self.assertAlmostEqual(float(d.loc[0, 'rv_pred']), rv)
            self.assertAlmostEqual(float(d.loc[0, 'whiff_pred']), wh)
        finally:
            s.stuff_models.clear(); s.stuff_models.update(saved_stuff)
            s.whiff_models.clear(); s.whiff_models.update(saved_whiff)
            s.scale_rv.clear(); s.scale_rv.update(saved_rv)
            s.scale_whiff.clear(); s.scale_whiff.update(saved_wh)


if __name__ == '__main__':
    unittest.main()
