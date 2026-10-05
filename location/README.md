# Location+ v3 and Pitching+ v1

`score_location.py` writes `location_plus_d1` and `pitching_plus` on `pitches`. It reads `stuff_plus_d1` and does not write `stuff_plus_d1` or `stuff_plus_juco`. Stuff+ v5 is unchanged. The TrackMan upload path is unchanged. New pitches stay null until this job runs.

The nightly job fills null grades only. Replacing these models does not change a grade that is already stored. The first deploy has to be a manual run with `LOCATION_RESCORE=1` (see below).

Models live in `location/models/`: one LightGBM text booster per pitch group, `location_scaling.json`, and the Pitching+ v1 second-stage files. Location+ v1 boosters and `location_scaling.json` are in `location/models_v1_backup/`.

## Location+ v3

Direct run-value model. Feature set `loc_count`: `PlateLocHeight`, `PlateLocSide`, `Balls`, `Strikes`. `w_rv` is 1.0, so Strike+ is not blended in. Left-handed pitchers flip `PlateLocSide` the same way Stuff+ flips `RelSide`. Height is not flipped. The flipped side is what the booster sees, under the name `PlateLocSide`.

Pitch group is the tagged-first Stuff+ rule: `TaggedPitchType` unless it is blank, `Undefined`, or `Other`, else `AutoPitchType`. Cutters stay CT.

Balls must be a whole number from 0 to 3 and strikes a whole number from 0 to 2. A missing count, a 4-ball count, or a fractional count is left blank. Those counts are not clipped. A pitch with no plate location, no pitch group, or a hand other than Left or Right is left blank, same as v1.

The stored pitch grade is the unshrunk Colab `LocationPlus_raw` (`LocationPlus_unshrunk`). Higher is better. From `location_scaling.json` `grade_refs`:

1. Predict expected run value.
2. `q_rv = ref_rv["{group}|{balls}|{strikes}"] - prediction`. This is the training definition `-(prediction - ref)`. A pitch with lower expected run value than that count grades higher. Using `prediction - ref` would invert the grade.
3. `c = q_rv / rv_sd`.
4. `location_plus_d1 = round(100 + 10 * (c - c_mu) / c_sd, 1)`.

`pitching_plus_v1_scaling.json` still describes the February–April Location+ v1 scale the second stage was trained on. It is not the Location+ v3 grade.

## Pitching+ v1 on Location+ v3

Pitching+ is still the second-stage booster `pitching_plus_v1_{FB,BB,OS,CT}.txt`. It was not retrained. It is not a 50/50 of Stuff+ and Location+. After this swap it consumes the v3 Location+ grade through the old z-score. A retrain of Pitching+ on v3 Location+ is recommended and is out of scope. Inputs, in order:

1. `StuffZ100` — z-score the stored Stuff+ v5 grade (`stuff_plus_d1`) with the February–April `train_z` block (`stuff_grade_mean` / `stuff_grade_sd`), then `100 + 10z`. Not `score_z`. The production Stuff+ models are not replaced.
2. `LocationZ100` — the same transform of the Location+ v3 grade above, using `location_grade_mean` / `location_grade_sd` from `train_z`. Those means and sds were fit on Location+ v1 grades. This is the grade on the pitch, not a different location number.
3. `Balls` — raw count, not z-scored. Pitching+ still accepts a count outside 0–3 / 0–2 when a Location+ grade is already stored. Location+ v3 will not create a new grade for that count.
4. `Strikes` — raw count, not z-scored.
5. `Platoon` — 1 when batter and pitcher are both Right or both Left, else 0. If batter side is missing or not Right or Left, Pitching+ stays blank. It is not filled with 0.

The grade is `100 + 10 * (scale_pitching[group].mean - prediction) / sd`. Run value only. `scale_pitching` sd is the spread of pitch-level predictions, not of pitcher averages.

With `LOCATION_RESCORE=1`, every Pitching+ grade that has Stuff+, Location+, count, hand, and batter side is recomputed from the new Location+ values.

## Rescore

Default (unset, `0`, or anything other than `1` / `true` / `yes`): fill null `location_plus_d1` and null `pitching_plus` only.

`LOCATION_RESCORE=1`: load every pitch and rewrite every gradeable `location_plus_d1`, then every `pitching_plus` that the second stage can compute. Stuff+ columns are never in the write payload.

The nightly workflow passes this from the **Run workflow** input `location_rescore`. The scheduled run leaves it at `0`. After this PR is merged, run the workflow once by hand and set that input to `1`. Later nights stay null-fill.

## Card scale and shrink

`location_plus_d1` is the unshrunk pitch grade, so a pitcher's mean of stored grades matches Colab `LocationPlus_unshrunk`. The staff-board shrink is

`100 + n / (n + kappa) * (raw_mean - 100)`

with `kappa` in `location_scaling.json` (`shrinkage.kappa`, about 143.63). `shrink_pitcher_mean` implements that. Nothing in this repo averages Location+ onto a card. `season/build_season_files.py` copies `stuff_plus_d1` and `stuff_plus_juco` into `data/seasons/` and does not copy `location_plus_d1` or `pitching_plus`. `ws-season-pitching.html` averages Stuff+ only. There is no Senators Analytics HTML in this repo with embedded Location+ grades, so the shrink is not applied on a page. Pitch grades stay unshrunk.
