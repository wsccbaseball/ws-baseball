# Stuff+

`score_stuff.py` grades unscored pitches and writes `stuff_plus_juco` and `stuff_plus_d1`. Groups are **FB**, **CT**, **BB**, and **OS**. A cutter is CT, not a fastball and not a breaker.

Typing is auto-first: `AutoPitchType`, then `TaggedPitchType` only when auto is blank, `Undefined`, or `Other`.

The 12 features in `models/scaling.json` are RelSpeed, SpinRate, InducedVertBreak, HorzBreak, AxisSin, AxisCos, RelHeight, RelSide, Extension, dVelo, dIVB, dHB. dVelo / dIVB / dHB are versus that pitcher-season's primary fastball (highest average velo among true FB types with at least 10 pitches). Cutters are not eligible for that baseline. CT, BB, and OS pitches still diff against it when the pitcher has one.

## Cutter model

`stuff_CT.txt` is not shipped here. Until that file and the `D1|CT` / `JUCO|CT` keys exist, the scorer logs a skip and leaves cutter pitches ungraded. It does not score them as FB.

Retrain Colab `stuff_plus_training_v2.ipynb` with CT as its own group, same features and the same target as FB, BB, and OS. Copy into `stuff/models/`:

- `stuff_CT.txt`
- `scaling.json`, including level×CT keys the same way as the other groups (`D1|CT`, `D2|CT`, `JUCO|CT`, `NAIA|CT`)

Then null `stuff_plus_juco` and `stuff_plus_d1` on pitches that were previously graded as fastballs and rerun `python stuff/score_stuff.py`.

The Stuff+ pages apply a second, pitcher-level scale from hardcoded spreads. After the retrain, add the CT spread next to FB/BB/OS in `PT_SCALE` in `ws-stuff.html` and `ws-season-pitching.html`. Do not invent that mean and sd. Until it is filled in, cutter pitch-type chips stay blank instead of using the fastball scale. Sample floors are unchanged.
