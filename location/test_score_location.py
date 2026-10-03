"""Location+ and Pitching+ scoring. No network. Uses the real boosters."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stuff'))
import score_location as loc
import score_stuff as stuff


def _pitch(**kw):
    row = dict(
        id=1, Pitcher='Ace', PitcherThrows='Right', BatterSide='Right',
        AutoPitchType='Fastball', TaggedPitchType='Fastball',
        PlateLocHeight=2.5, PlateLocSide=0.2, Balls=1, Strikes=1,
        stuff_plus_d1=104.0, location_plus_d1=np.nan, pitching_plus=np.nan,
    )
    row.update(kw)
    return row


class TypingTests(unittest.TestCase):
    def test_matches_stuff_plus_tagged_first(self):
        rows = [
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType=None, TaggedPitchType='Cutter'),
            _pitch(AutoPitchType='Undefined', TaggedPitchType='Slider'),
            _pitch(AutoPitchType='Other', TaggedPitchType='Fastball'),
            _pitch(AutoPitchType='', TaggedPitchType='Sinker'),
            _pitch(AutoPitchType='Cutter', TaggedPitchType='Undefined'),
            _pitch(AutoPitchType='ChangeUp', TaggedPitchType='Other'),
            _pitch(AutoPitchType='FC', TaggedPitchType='Slider'),
        ]
        d = pd.DataFrame(rows)
        self.assertEqual(list(loc.ptype(d)), list(stuff.ptype(d)))
        self.assertEqual([loc.pitch_group(t) for t in loc.ptype(d)],
                         [stuff.pitch_group(t) for t in stuff.ptype(d)])
        self.assertEqual(loc.pitch_group(list(loc.ptype(d))[0]), 'FB')
        self.assertEqual(loc.pitch_group(list(loc.ptype(d))[1]), 'CT')


class LocationTests(unittest.TestCase):
    def test_lefty_flips_side_not_height(self):
        r = loc.score(pd.DataFrame([
            _pitch(PitcherThrows='Right', PlateLocHeight=2.2, PlateLocSide=0.4),
            _pitch(id=2, PitcherThrows='Left', PlateLocHeight=2.2, PlateLocSide=-0.4),
            _pitch(id=3, PitcherThrows='Left', PlateLocHeight=2.2, PlateLocSide=0.4),
        ]))
        self.assertEqual(r.loc[0, 'location_plus_d1'], r.loc[1, 'location_plus_d1'])
        self.assertNotEqual(r.loc[0, 'location_plus_d1'], r.loc[2, 'location_plus_d1'])
        pre = loc.prepare(pd.DataFrame([_pitch(PitcherThrows='Left', PlateLocHeight=2.2, PlateLocSide=0.4)]))
        self.assertAlmostEqual(pre.loc[0, 'loc_height'], 2.2)
        self.assertAlmostEqual(pre.loc[0, 'loc_side'], -0.4)

    def test_grade_uses_scale_location_not_a_blend(self):
        raw = _pitch(PlateLocHeight=2.4, PlateLocSide=-0.3)
        scored = loc.score(pd.DataFrame([raw]))
        pre = loc.prepare(pd.DataFrame([raw]))
        X = pd.DataFrame({
            'PlateLocHeight': [pre.loc[0, 'loc_height']],
            'PlateLocSide': [pre.loc[0, 'loc_side']],
        })
        pred = loc.loc_models['FB'].predict(X)[0]
        sc = loc.scale_location['D1|FB']
        expect = round(100 + 10 * (sc['mean'] - pred) / sc['sd'], 1)
        self.assertAlmostEqual(scored.loc[0, 'location_plus_d1'], expect)
        self.assertNotAlmostEqual(scored.loc[0, 'location_plus_d1'], 0.5 * (104.0 + expect))

    def test_skips_missing_location_group_or_hand(self):
        scored = loc.score(pd.DataFrame([
            _pitch(PlateLocHeight=None),
            _pitch(id=2, PlateLocSide=None),
            _pitch(id=3, TaggedPitchType='Other', AutoPitchType='Other'),
            _pitch(id=4, PitcherThrows='Undefined'),
            _pitch(id=5),
        ]))
        self.assertTrue(scored.loc[0, 'location_plus_d1'] != scored.loc[0, 'location_plus_d1'])
        self.assertTrue(pd.isna(scored.loc[1, 'location_plus_d1']))
        self.assertTrue(pd.isna(scored.loc[2, 'location_plus_d1']))
        self.assertTrue(pd.isna(scored.loc[3, 'location_plus_d1']))
        self.assertTrue(pd.notna(scored.loc[4, 'location_plus_d1']))

    def test_cutter_is_not_scored_as_fastball(self):
        fb = loc.score(pd.DataFrame([_pitch(TaggedPitchType='Fastball', PlateLocHeight=1.6, PlateLocSide=0.9)]))
        ct = loc.score(pd.DataFrame([_pitch(TaggedPitchType='Cutter', PlateLocHeight=1.6, PlateLocSide=0.9)]))
        self.assertEqual(fb.loc[0, 'PGroup'], 'FB')
        self.assertEqual(ct.loc[0, 'PGroup'], 'CT')
        self.assertNotEqual(fb.loc[0, 'location_plus_d1'], ct.loc[0, 'location_plus_d1'])


class PitchingTests(unittest.TestCase):
    def test_uses_train_z_and_five_raw_inputs(self):
        raw = _pitch(Balls=4, Strikes=2, stuff_plus_d1=110.0, BatterSide='Left', PitcherThrows='Right')
        scored = loc.score(pd.DataFrame([raw]))
        loc_grade = float(scored.loc[0, 'location_plus_d1'])
        tz = loc.train_z['FB']
        sz = loc.cfg['score_z']['FB']
        stuff_in = loc.z100(110.0, tz['stuff_grade_mean'], tz['stuff_grade_sd'])
        loc_in = loc.z100(loc_grade, tz['location_grade_mean'], tz['location_grade_sd'])
        score_window = loc.z100(110.0, sz['stuff_mean'], sz['stuff_sd'])
        self.assertNotAlmostEqual(float(stuff_in), float(score_window), places=2)
        X = pd.DataFrame({
            'StuffZ100': [float(stuff_in)],
            'LocationZ100': [float(loc_in)],
            'Balls': [4.0],
            'Strikes': [2.0],
            'Platoon': [0.0],
        })
        pred = loc.pit_models['FB'].predict(X)[0]
        sc = loc.scale_pitching['FB']
        expect = round(100 + 10 * (sc['mean'] - pred) / sc['sd'], 1)
        self.assertAlmostEqual(scored.loc[0, 'pitching_plus'], expect)
        blend = round(0.5 * (110.0 + loc_grade), 1)
        self.assertNotAlmostEqual(scored.loc[0, 'pitching_plus'], blend)

    def test_platoon_and_missing_batter_side(self):
        same = loc.score(pd.DataFrame([_pitch(BatterSide='Right', PitcherThrows='Right')]))
        opp = loc.score(pd.DataFrame([_pitch(BatterSide='Left', PitcherThrows='Right')]))
        missing = loc.score(pd.DataFrame([
            _pitch(BatterSide=None),
            _pitch(id=2, BatterSide='Undefined'),
            _pitch(id=3, BatterSide=''),
        ]))
        self.assertTrue(pd.notna(same.loc[0, 'pitching_plus']))
        self.assertTrue(pd.notna(opp.loc[0, 'pitching_plus']))
        self.assertNotEqual(same.loc[0, 'pitching_plus'], opp.loc[0, 'pitching_plus'])
        self.assertTrue(pd.isna(missing.loc[0, 'pitching_plus']))
        self.assertTrue(pd.isna(missing.loc[1, 'pitching_plus']))
        self.assertTrue(pd.isna(missing.loc[2, 'pitching_plus']))
        self.assertTrue(pd.notna(missing.loc[0, 'location_plus_d1']))

    def test_pitching_blank_without_stored_stuff(self):
        scored = loc.score(pd.DataFrame([_pitch(stuff_plus_d1=None)]))
        self.assertTrue(pd.notna(scored.loc[0, 'location_plus_d1']))
        self.assertTrue(pd.isna(scored.loc[0, 'pitching_plus']))

    def test_does_not_replace_an_existing_location_grade(self):
        scored = loc.score(pd.DataFrame([_pitch(location_plus_d1=91.2)]))
        self.assertAlmostEqual(scored.loc[0, 'location_plus_d1'], 91.2)
        self.assertTrue(pd.notna(scored.loc[0, 'pitching_plus']))

    def test_write_payload_never_includes_stuff(self):
        before = pd.DataFrame([_pitch(stuff_plus_d1=103.4)])
        after = loc.score(before)
        rows = loc.rows_to_write(before, after)
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {'id', 'location_plus_d1', 'pitching_plus'})
        self.assertNotIn('stuff_plus_d1', rows[0])
        self.assertNotIn('stuff_plus_juco', rows[0])
        again = loc.rows_to_write(after, after)
        self.assertEqual(again, [])


if __name__ == '__main__':
    unittest.main()
