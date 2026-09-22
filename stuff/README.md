# Stuff+

`score_stuff.py` grades unscored pitches and writes `stuff_plus_juco` and `stuff_plus_d1`. Groups are **FB**, **CT**, **BB**, and **OS**. A cutter is CT, not a fastball and not a breaker.

Typing is auto-first: `AutoPitchType`, then `TaggedPitchType` only when auto is blank, `Undefined`, or `Other`.

The 12 features in `models/scaling.json` are RelSpeed, SpinRate, InducedVertBreak, HorzBreak, AxisSin, AxisCos, RelHeight, RelSide, Extension, dVelo, dIVB, dHB. dVelo / dIVB / dHB are versus that pitcher-season's primary fastball (highest average velo among true FB types with at least 10 pitches). Cutters are not eligible for that baseline. CT, BB, and OS pitches still diff against it when the pitcher has one.

## Cutter model

Colab v3 is in `stuff/models/`: `stuff_FB.txt`, `stuff_BB.txt`, `stuff_OS.txt`, `stuff_CT.txt`, and `scaling.json` with `D1|CT`, `D2|CT`, `JUCO|CT`, and `NAIA|CT`. The scorer grades CT when `stuff_CT.txt` plus `D1|CT` and `JUCO|CT` are present. If either is missing, it logs a skip and leaves cutter pitches unscored.

To pick up grades for pitches that were scored while cutters were fastballs, null `stuff_plus_juco` and `stuff_plus_d1` on those rows and rerun `python stuff/score_stuff.py`.

`PT_SCALE.CT` in `ws-stuff.html` and `ws-season-pitching.html` is the D1 pitcher-level cutter spread from the 2026 Colab leaderboard: rows with `PGroup == CT` and `n >= 30` (65 pitchers). Mean of `stuff_d1` is 100.641 and the population sd is 2.533. Sample floors are unchanged.
