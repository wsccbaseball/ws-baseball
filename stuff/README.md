# Stuff+

`score_stuff.py` grades unscored pitches and writes `stuff_plus_juco` and `stuff_plus_d1`. Groups are **FB**, **CT**, **BB**, and **OS**. A cutter is CT, not a fastball and not a breaker.

Typing is tagged-first: `TaggedPitchType` when it is present and not blank, `Undefined`, or `Other`; otherwise `AutoPitchType`. Both pass through the CANON map. There is no Auto=Cutter override. On Walters State, TrackMan `AutoPitchType='Cutter'` is usually a tagged fastball within about 0–1.5 mph of that pitcher's heater, so forcing those into CT would mis-bucket real fastballs. A pitch whose resolved type is Cutter still scores in its own CT group.

The 17 features in `models/scaling.json` are RelSpeed, SpinRate, InducedVertBreak, HorzBreak, AxisSin, AxisCos, RelHeight, RelSide, Extension, dVelo, dIVB, dHB, ArmAngle, dVelo_day, dIVB_day, dHB_day, dSpin_day. dVelo / dIVB / dHB are versus that pitcher's primary fastball (highest average velo among true FB types with at least 10 pitches, across all of that pitcher's pitches). Cutters are not eligible for that baseline. CT, BB, and OS pitches still diff against it when the pitcher has one. Day diffs are versus the most-used FB type that pitcher threw that day, tie-broken by higher velocity. ArmAngle is `degrees(atan2(RelSide, RelHeight))` after the left-handed RelSide flip.

## v5 blend

Colab v5 is in `stuff/models/`: `stuff_FB.txt`, `stuff_BB.txt`, `stuff_OS.txt`, `stuff_CT.txt`, matching `whiff_*.txt` boosters, and `scaling.json` (`version` `v5`) with `scale_rv` and `scale_whiff` for D1 and JUCO (plus D2 and NAIA). Stuff+ is `100 + 10 * (0.5 * z_rv + 0.5 * z_whiff)`. The previous v4 boosters and `scaling.json` are in `stuff/models_v4_backup/`. v3 remains in `stuff/models_v3_backup/`. The scorer grades a group only when both boosters and the D1 and JUCO `scale_rv` / `scale_whiff` keys exist. If CT is missing, it logs a skip and leaves cutter pitches unscored. The nightly job still only fills null grades.

To pick up grades for pitches that were scored while cutters were fastballs, null `stuff_plus_juco` and `stuff_plus_d1` on those rows and rerun `python stuff/score_stuff.py`.

The Stuff+ pages show the mean of the stored grades. `scaling.json` already puts each pitch on a level×group scale (100 = average, 10 = one standard deviation of pitches), so the pages do not apply a second pitcher-level stretch. The old display constants (`OVERALL_*` / `PT_SCALE`, including the cutter leaderboard mean 100.641 and sd 2.533) are not used.

Sample floors: staff Min pitches defaults to 50; overall chips gray under 150 pitches; pitch-type chips gray under 40; an outing overall grays under 75; an outing pitch type grays under 30. Staff rows under the Min pitches setting sort below everyone else on numeric columns.
