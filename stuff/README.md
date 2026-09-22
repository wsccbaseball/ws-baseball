# Stuff+

`score_stuff.py` grades unscored pitches and writes `stuff_plus_juco` and `stuff_plus_d1`. Groups are **FB**, **CT**, **BB**, and **OS**. A cutter is CT, not a fastball and not a breaker.

Typing is tagged-first: `TaggedPitchType` when it is present and not blank, `Undefined`, or `Other`; otherwise `AutoPitchType`. Both pass through the CANON map. There is no Auto=Cutter override. On Walters State, TrackMan `AutoPitchType='Cutter'` is usually a tagged fastball within about 0–1.5 mph of that pitcher's heater, so forcing those into CT would mis-bucket real fastballs. A pitch whose resolved type is Cutter still scores in its own CT group.

The 12 features in `models/scaling.json` are RelSpeed, SpinRate, InducedVertBreak, HorzBreak, AxisSin, AxisCos, RelHeight, RelSide, Extension, dVelo, dIVB, dHB. dVelo / dIVB / dHB are versus that pitcher-season's primary fastball (highest average velo among true FB types with at least 10 pitches). Cutters are not eligible for that baseline. CT, BB, and OS pitches still diff against it when the pitcher has one.

## Cutter model

Colab v3 is in `stuff/models/`: `stuff_FB.txt`, `stuff_BB.txt`, `stuff_OS.txt`, `stuff_CT.txt`, and `scaling.json` with `D1|CT`, `D2|CT`, `JUCO|CT`, and `NAIA|CT`. The scorer grades CT when `stuff_CT.txt` plus `D1|CT` and `JUCO|CT` are present. If either is missing, it logs a skip and leaves cutter pitches unscored.

To pick up grades for pitches that were scored while cutters were fastballs, null `stuff_plus_juco` and `stuff_plus_d1` on those rows and rerun `python stuff/score_stuff.py`.

The Stuff+ pages show the mean of the stored grades. `scaling.json` already puts each pitch on a level×group scale (100 = average, 10 = one standard deviation of pitches), so the pages do not apply a second pitcher-level stretch. The old display constants (`OVERALL_*` / `PT_SCALE`, including the cutter leaderboard mean 100.641 and sd 2.533) are not used.

Sample floors: staff Min pitches defaults to 50; overall chips gray under 150 pitches; pitch-type chips gray under 40; an outing overall grays under 75; an outing pitch type grays under 30. Staff rows under the Min pitches setting sort below everyone else on numeric columns.
