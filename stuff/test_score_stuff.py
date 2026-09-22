"""Group, typing, and CT-skip tests for score_stuff. No network and no fake model file."""
import os
import sys
import unittest

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

    def test_auto_first_then_canon(self):
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
        ])
        got = list(s.ptype(d))
        self.assertEqual(got, [
            'Cutter', 'Cutter', 'Slider', 'Fastball', 'Sinker',
            'Fastball', 'Changeup', 'Slider', 'Cutter', 'Cutter',
        ])

    def test_primary_fastball_ignores_harder_cutter(self):
        rows = []
        for _ in range(12):
            rows.append(dict(PType='Cutter', RelSpeed=96, InducedVertBreak=8, HorzBreak=3,
                             Key='ACE_R', Season='2026S'))
            rows.append(dict(PType='Fastball', RelSpeed=91, InducedVertBreak=17, HorzBreak=9,
                             Key='ACE_R', Season='2026S'))
        base = s.primary_fastball(pd.DataFrame(rows))
        self.assertAlmostEqual(base.loc[('ACE_R', '2026S'), 'v'], 91)
        self.assertAlmostEqual(base.loc[('ACE_R', '2026S'), 'ivb'], 17)

    def test_cutter_only_pitcher_has_no_fastball_baseline(self):
        rows = [dict(PType='Cutter', RelSpeed=90, InducedVertBreak=8, HorzBreak=2,
                     Key='ACE_R', Season='2026S') for _ in range(15)]
        base = s.primary_fastball(pd.DataFrame(rows))
        self.assertTrue(base.empty)

    def test_build_routes_groups_and_diffs_against_true_fb(self):
        base = pd.DataFrame(
            {'v': [92.0], 'ivb': [16.0], 'hb': [8.0]},
            index=pd.MultiIndex.from_tuples([('ACE_R', '2026S')], names=['Key', 'Season']))
        raw = pd.DataFrame([
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Fastball', RelSpeed=88,
                   InducedVertBreak=8, HorzBreak=4),
            _pitch(AutoPitchType='Four-Seam', TaggedPitchType='Sinker', RelSpeed=93),
            _pitch(AutoPitchType='Slider', TaggedPitchType='Cutter', RelSpeed=84),
            _pitch(AutoPitchType='Changeup', TaggedPitchType='Fastball', RelSpeed=83),
        ])
        d = s.build(raw, base).set_index('PType')
        self.assertEqual(d.loc['Cutter', 'PGroup'], 'CT')
        self.assertEqual(d.loc['Fastball', 'PGroup'], 'FB')
        self.assertEqual(d.loc['Slider', 'PGroup'], 'BB')
        self.assertEqual(d.loc['Changeup', 'PGroup'], 'OS')
        self.assertAlmostEqual(d.loc['Cutter', 'dVelo'], -4)
        self.assertAlmostEqual(d.loc['Cutter', 'dIVB'], -8)
        self.assertAlmostEqual(d.loc['Cutter', 'dHB'], -4)
        self.assertAlmostEqual(d.loc['Changeup', 'dVelo'], -9)
        self.assertAlmostEqual(d.loc['Fastball', 'dVelo'], 1)


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
                'RelHeight', 'RelSide', 'Extension', 'dVelo', 'dIVB', 'dHB']
        self.assertEqual(list(s.FEATS), want)
        for g in ('FB', 'BB', 'OS', 'CT'):
            self.assertIn(g, s.models)
            self.assertEqual(s.models[g].feature_name(), want)
        for key in ('D1|CT', 'D2|CT', 'JUCO|CT', 'NAIA|CT'):
            self.assertGreater(s.scale[key]['sd'], 0)
        self.assertIsNone(s.ct_block_reason())
        self.assertTrue(s.group_ready('CT'))
        d = s.score(self._frame())
        pred = float(d.loc[1, 'rv_pred'])
        juco, d1 = s.scale['JUCO|CT'], s.scale['D1|CT']
        self.assertAlmostEqual(d.loc[1, 'stuff_plus_juco'], round(100 + 10 * (juco['mean'] - pred) / juco['sd'], 1))
        self.assertAlmostEqual(d.loc[1, 'stuff_plus_d1'], round(100 + 10 * (d1['mean'] - pred) / d1['sd'], 1))
        fb = s.scale['JUCO|FB']
        self.assertNotAlmostEqual(d.loc[1, 'stuff_plus_juco'], round(100 + 10 * (fb['mean'] - pred) / fb['sd'], 1))

    def test_missing_ct_model_does_not_score_cutters_as_fb(self):
        saved_models = dict(s.models)
        saved_scale = dict(s.scale)
        try:
            s.models.pop('CT', None)
            s.scale.pop('D1|CT', None)
            s.scale.pop('JUCO|CT', None)
            self.assertIsNotNone(s.ct_block_reason())
            self.assertFalse(s.group_ready('CT'))
            self.assertTrue(s.group_ready('FB'))
            d = s.score(self._frame())
            self.assertTrue(pd.notna(d.loc[0, 'stuff_plus_juco']))
            self.assertTrue(pd.notna(d.loc[0, 'stuff_plus_d1']))
            self.assertTrue(pd.isna(d.loc[1, 'stuff_plus_juco']))
            self.assertTrue(pd.isna(d.loc[1, 'stuff_plus_d1']))
            self.assertTrue(pd.isna(d.loc[1, 'rv_pred']))
        finally:
            s.models.clear()
            s.models.update(saved_models)
            s.scale.clear()
            s.scale.update(saved_scale)

    def test_ct_scale_keys_are_used_when_present(self):
        saved_models = dict(s.models)
        saved_scale = dict(s.scale)
        try:
            s.models['CT'] = s.models['FB']
            s.scale['D1|CT'] = {'mean': 0.02, 'sd': 0.01}
            s.scale['JUCO|CT'] = {'mean': 0.03, 'sd': 0.02}
            self.assertIsNone(s.ct_block_reason())
            d = s.score(self._frame())
            pred = float(d.loc[1, 'rv_pred'])
            juco = 100 + 10 * (0.03 - pred) / 0.02
            d1 = 100 + 10 * (0.02 - pred) / 0.01
            fb_pred = float(d.loc[0, 'rv_pred'])
            fb_juco_scale = s.scale['JUCO|FB']
            fb_as_fb = 100 + 10 * (fb_juco_scale['mean'] - pred) / fb_juco_scale['sd']
            self.assertAlmostEqual(d.loc[1, 'stuff_plus_juco'], round(juco, 1))
            self.assertAlmostEqual(d.loc[1, 'stuff_plus_d1'], round(d1, 1))
            self.assertNotAlmostEqual(d.loc[1, 'stuff_plus_juco'], round(fb_as_fb, 1))
            self.assertAlmostEqual(fb_pred, pred)
        finally:
            s.models.clear()
            s.models.update(saved_models)
            s.scale.clear()
            s.scale.update(saved_scale)


if __name__ == '__main__':
    unittest.main()
