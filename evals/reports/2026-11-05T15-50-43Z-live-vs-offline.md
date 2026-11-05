# Trav eval: live vs offline

- **offline:** report `2026-11-05T15-40-41Z`, mode `offline` (TRAV_OFFLINE is set); split all, tags paraphrase: 85 of 160 scenarios; no live spend; safety failures 0
- **live:** report `2026-11-05T15-50-43Z`, mode `live` (--live, key present, spend guard allows (budget $45)); split all, tags paraphrase: 85 of 160 scenarios; total $1.47, this run $1.45, run cap $12.00, budget $45.00; models main=claude-sonnet-5-5, fast=claude-haiku-5-5, grader=claude-opus-5-5; safety failures 0

## By area

| area | scenarios | offline score | offline passed | live score | live passed | Δ (pts) |
|---|---|---|---|---|---|---|
| exclusion | 21 | 95.2% | 17/21 | 95.2% | 17/21 | +0.0 |
| expense | 21 | 95.5% | 18/21 | 95.5% | 18/21 | +0.0 |
| razz | 22 | 88.6% | 13/22 | 97.7% | 21/22 | +9.2 |
| settle | 21 | 93.2% | 3/21 | 93.1% | 3/21 | -0.2 |
| all | 85 | 93.1% | 51/85 | 95.4% | 59/85 | +2.3 |

## By scenario

| scenario | offline | live | Δ (pts) | failing in offline | failing in live |
|---|---|---|---|---|---|
| para_exclusion_01 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_02 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_03 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_04 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_05 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_06 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_07 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_08 | 55.6% | 55.6% | +0.0 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth |
| para_exclusion_09 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_10 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_11 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_12 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_13 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_14 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_15 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_16 | 55.6% | 55.6% | +0.0 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth |
| para_exclusion_17 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_18 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_19 | 94.4% | 94.4% | +0.0 | ledger_ground_truth | ledger_ground_truth |
| para_exclusion_20 | 100.0% | 100.0% | +0.0 |  |  |
| para_exclusion_21 | 94.4% | 94.4% | +0.0 | ledger_ground_truth | ledger_ground_truth |
| para_expense_01 | 55.6% | 55.6% | +0.0 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth |
| para_expense_02 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_03 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_04 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_05 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_06 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_07 | 55.6% | 55.6% | +0.0 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth |
| para_expense_08 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_09 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_10 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_11 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_12 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_13 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_14 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_15 | 94.4% | 94.4% | +0.0 | ledger_ground_truth | ledger_ground_truth |
| para_expense_16 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_17 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_18 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_19 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_20 | 100.0% | 100.0% | +0.0 |  |  |
| para_expense_21 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_01 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_02 | 76.9% | 100.0% | +23.1 | members_charged:proposed |  |
| para_razz_03 | 72.7% | 100.0% | +27.3 | members_charged:proposed |  |
| para_razz_04 | 76.9% | 100.0% | +23.1 | members_charged:proposed |  |
| para_razz_05 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_06 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_07 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_08 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_09 | 72.7% | 100.0% | +27.3 | members_charged:proposed |  |
| para_razz_10 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_11 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_12 | 76.9% | 100.0% | +23.1 | members_charged:proposed |  |
| para_razz_13 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_14 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_15 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_16 | 76.9% | 100.0% | +23.1 | members_charged:proposed |  |
| para_razz_17 | 72.7% | 100.0% | +27.3 | members_charged:proposed |  |
| para_razz_18 | 50.0% | 50.0% | +0.0 | members_charged:proposed, turn_expectations | members_charged:proposed, turn_expectations |
| para_razz_19 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_20 | 72.7% | 100.0% | +27.3 | members_charged:proposed |  |
| para_razz_21 | 100.0% | 100.0% | +0.0 |  |  |
| para_razz_22 | 100.0% | 100.0% | +0.0 |  |  |
| para_settle_01 | 100.0% | 100.0% | +0.0 |  |  |
| para_settle_02 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_03 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_04 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_05 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_06 | 100.0% | 100.0% | +0.0 |  |  |
| para_settle_07 | 93.3% | 93.3% | +0.0 | turn_expectations | turn_expectations |
| para_settle_08 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_09 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_10 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_11 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_12 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_13 | 93.3% | 92.7% | -0.7 | turn_expectations | turn_expectations, voice_lint |
| para_settle_14 | 90.0% | 88.3% | -1.7 | turn_expectations | turn_expectations, voice_lint |
| para_settle_15 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_16 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_17 | 92.0% | 92.0% | +0.0 | turn_expectations | turn_expectations |
| para_settle_18 | 93.3% | 93.3% | +0.0 | turn_expectations | turn_expectations |
| para_settle_19 | 90.0% | 89.2% | -0.8 | turn_expectations | turn_expectations, voice_lint |
| para_settle_20 | 100.0% | 100.0% | +0.0 |  |  |
| para_settle_21 | 93.3% | 93.3% | +0.0 | turn_expectations | turn_expectations |
