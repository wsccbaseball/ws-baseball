# Stuff+

`score_stuff.py` writes `stuff_plus_juco` and `stuff_plus_d1`. By default it grades unscored pitches. `STUFF_RESCORE=1` rewrites every gradeable pitch in place. Groups are **FB**, **CT**, **BB**, and **OS**. A cutter is CT, not a fastball and not a breaker.

Typing is tagged-first: `TaggedPitchType` when it is present and not blank, `Undefined`, or `Other`; otherwise `AutoPitchType`. Both pass through the CANON map. There is no Auto=Cutter override. On Walters State, TrackMan `AutoPitchType='Cutter'` is usually a tagged fastball within about 0–1.5 mph of that pitcher's heater, so forcing those into CT would mis-bucket real fastballs. A pitch whose resolved type is Cutter still scores in its own CT group.

The 20 features in `models/scaling.json` are the v5 17 plus `PThrowL`, `BatL`, and `SameHand` appended: RelSpeed, SpinRate, InducedVertBreak, HorzBreak, AxisSin, AxisCos, RelHeight, RelSide, Extension, dVelo, dIVB, dHB, ArmAngle, dVelo_day, dIVB_day, dHB_day, dSpin_day, PThrowL, BatL, SameHand. dVelo / dIVB / dHB are versus that pitcher's primary fastball (highest average velo among true FB types with at least 10 pitches, across all of that pitcher's pitches). Cutters are not eligible for that baseline. CT, BB, and OS pitches still diff against it when the pitcher has one. Day diffs are versus the most-used FB type that pitcher threw that day, tie-broken by higher velocity. ArmAngle is `degrees(atan2(RelSide, RelHeight))` after the left-handed RelSide flip.

Hand encoding, after that mirror:

- `PThrowL` is 1.0 when `PitcherThrows` is Left, else 0.0. `build()` already drops any hand that is not Left or Right.
- `BatL` is 1.0 when `BatterSide` is Left, 0.0 when it is Right, and missing otherwise (Switch, Undefined, blank). Leave it missing. LightGBM handles that.
- `SameHand` is 1.0 when `BatterSide` equals `PitcherThrows`, 0.0 when they are opposite Left/Right, and missing when batter side is not Left or Right.

A pitch is graded for the batter it was thrown to. The same shape is a different Stuff+ against a left-handed batter and a right-handed batter. Pitcher averages mix in that pitcher's actual batter-hand mix. There is no extra lefty board adjustment on top of this.

## v6 blend

Stuff+ v6 is in `stuff/models/`: `stuff_FB.txt`, `stuff_BB.txt`, `stuff_OS.txt`, `stuff_CT.txt`, matching `whiff_*.txt` boosters, `constraints.json`, and `scaling.json` (`version` `v6`) with `scale_rv` and `scale_whiff` for D1 and JUCO (plus D2 and NAIA). Trained on the full January–June 2026 season. Stuff+ is `100 + 10 * (0.5 * z_rv + 0.5 * z_whiff)`. The previous v5 bundle is in `stuff/models_v5_backup/`. v4 remains in `stuff/models_v4_backup/`. v3 remains in `stuff/models_v3_backup/`. The scorer grades a group only when both boosters and the D1 and JUCO `scale_rv` / `scale_whiff` keys exist. If CT is missing, it logs a skip and leaves cutter pitches unscored.

The nightly job fills null `stuff_plus_juco` only. Swapping the bundle does not change a grade that is already stored.

## One-time rescore

`STUFF_RESCORE=1` (also `true` or `yes`) loads every pitch, rebuilds features from the full table so primary-fastball baselines stay stable, and rewrites every gradeable `stuff_plus_juco` and `stuff_plus_d1` through `rpc/set_stuff_plus`. Unset or `0` is the nightly null-fill. The rescore updates grades in place. It does not delete games or pitches, and it does not null a row `build()` cannot grade.

The nightly workflow passes this from the **Run workflow** input `stuff_rescore`. The scheduled run leaves it at `0`. After this PR is merged, run **Stuff+, Location+, and Pitching+ nightly scoring** once by hand with `stuff_rescore` = `1` and `location_rescore` = `1`.

Pitching+ v1 reads the stored `stuff_plus_d1` and was not retrained. `location_rescore=1` on that same run recomputes Pitching+ from the new Stuff+ grades. Location+ v3 does not read Stuff+, and its model is unchanged. The workflow then refreshes `data/seasons/*.json` from the stored Stuff+ grades. Later nights stay null-fill.

The Stuff+ pages show the mean of the stored grades. `scaling.json` already puts each pitch on a level×group scale (100 = average, 10 = one standard deviation of pitches), so the pages do not apply a second pitcher-level stretch. The old display constants (`OVERALL_*` / `PT_SCALE`, including the cutter leaderboard mean 100.641 and sd 2.533) are not used.

Sample floors: staff Min pitches defaults to 50; overall chips gray under 150 pitches; pitch-type chips gray under 40; an outing overall grays under 75; an outing pitch type grays under 30. Staff rows under the Min pitches setting sort below everyone else on numeric columns.
