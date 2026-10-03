# Location+ v1 and Pitching+ v1

`score_location.py` fills null `location_plus_d1` and `pitching_plus` on `pitches`. It reads `stuff_plus_d1` and does not write it. The TrackMan upload path is unchanged. New pitches stay null until this job runs.

Models live in `location/models/`, the same layout as `stuff/models/`: one LightGBM text booster per pitch group, plus the scaling files.

## Location+

Features are only `PlateLocHeight` and `PlateLocSide`. Left-handed pitchers flip `PlateLocSide` the same way Stuff+ flips `RelSide`. Height is not flipped. Pitch group is the tagged-first Stuff+ rule: `TaggedPitchType` unless it is blank, `Undefined`, or `Other`, else `AutoPitchType`. Cutters stay CT.

The card grade, and the grade Pitching+ consumes, is

`100 + 10 * (scale_location[D1|group].mean - prediction) / sd`

from `pitching_plus_v1_scaling.json`. Higher is better. `location_scaling.json` is stored with the booster and is not a second grade. A pitch with no plate location, no pitch group, or a hand other than Left or Right is left blank.

## Pitching+

Pitching+ is the second-stage booster `pitching_plus_v1_{FB,BB,OS,CT}.txt`. It is not a 50/50 of Stuff+ and Location+. Inputs, in order:

1. `StuffZ100` — z-score the stored Stuff+ v5 grade (`stuff_plus_d1`) with the February–April `train_z` block (`stuff_grade_mean` / `stuff_grade_sd`), then `100 + 10z`. Not `score_z`. The production Stuff+ models are not replaced.
2. `LocationZ100` — the same transform of the Location+ grade above, using `location_grade_mean` / `location_grade_sd` from `train_z`. This is the grade on the card, not a different location number.
3. `Balls` — raw count, not z-scored.
4. `Strikes` — raw count, not z-scored.
5. `Platoon` — 1 when batter and pitcher are both Right or both Left, else 0. If batter side is missing or not Right or Left, Pitching+ stays blank. It is not filled with 0.

The grade is `100 + 10 * (scale_pitching[group].mean - prediction) / sd`. Run value only. `scale_pitching` sd is the spread of pitch-level predictions, not of pitcher averages.

## Card scale

The season card shows the mean of these pitch grades next to the pitch count. Under 100 scored pitches, that grade is hidden and the count stays. There is no D1 pitcher-average standard deviation in this repo or in the scaling file, so the card does not apply a second, pitcher-level stretch. 100 is an average pitch. 10 points is one standard deviation of pitches. 85 is 1.5 standard deviations below an average pitch, not 15 percent worse.
