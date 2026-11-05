# Trav eval: live vs offline

- **offline:** report `2026-11-05T15-40-41Z`, mode `offline` (TRAV_OFFLINE is set); split all, tags paraphrase: 85 of 160 scenarios; no live spend; safety failures 0
- **live:** report `2026-11-05T16-21-05Z`, mode `live` (--live, key present, spend guard allows (budget $45)); split all, tags paraphrase: 85 of 160 scenarios (stopped early: 47 run); total $14.42, this run $4.81, run cap $4.80, budget $45.00; models main=claude-sonnet-5-5, fast=claude-haiku-5-5, grader=claude-opus-5-5; stopped early: run spend cap $4.80 reached ($4.81 this run) after 47 of 85 scenarios; next was para_razz_06; safety failures 0

## Read this first

- **live (`2026-11-05T16-21-05Z`): 10 rubric grader calls failed, in 9 of 47 scenarios**: grader call failed: model returned non-JSON for eval_rubric_v1. Those results are skipped, never passes, so the rubric part of those scenarios' scores is missing.
- This rerun had the schema fix: 189 claude-opus-5-5 grader calls went through. 10 rubric calls still failed with 'non-JSON', most likely the 300-token output cap cutting off the grader's JSON (raised to 1024 after this run, not yet verified live). The run stopped at its $4.80 run cap after 47 of 85 scenarios.
- Live Trav calls, from .trav/spend.json (this summary predates modelCalls): claude-sonnet-5-5 calls went from 363 to 368, so the 5 razz scenarios made 5 calls and **the 42 exclusion and expense scenarios made no live calls (deterministic path)**.

## By area

Live Trav calls: model calls Trav made (from the summary's `modelCalls`); `0: no live calls (deterministic path)` means the score measures code, not the model. Grader calls: results skipped because the grader call itself failed / all other skipped results.

| area | scenarios | offline score | offline passed | live score | live passed | Δ (pts) | offline live Trav calls | live live Trav calls | offline grader calls failed / skipped | live grader calls failed / skipped |
|---|---|---|---|---|---|---|---|---|---|---|
| exclusion | 21 | 95.2% | 17/21 | 94.1% | 17/21 | -1.1 | offline | not recorded | 0 / 401 | 6 / 380 |
| expense | 21 | 95.5% | 18/21 | 94.2% | 15/21 | -1.3 | offline | not recorded | 0 / 401 | 2 / 380 |
| razz | 5 | 85.3% | 2/5 | 98.8% | 3/5 | +13.5 | offline | not recorded | 0 / 94 | 2 / 78 |
| all | 47 | 94.3% | 37/47 | 94.6% | 35/47 | +0.3 | offline | not recorded | 0 / 896 | 10 / 838 |

## By scenario

| scenario | offline | live | Δ (pts) | failing in offline | failing in live |
|---|---|---|---|---|---|
| para_exclusion_01 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_02 | 100.0% | 99.0% | -1.0 |  |  |
| para_exclusion_03 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_04 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_05 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_06 | 100.0% | 99.0% | -1.0 |  |  |
| para_exclusion_07 | 100.0% | 98.7% | -1.3 |  |  |
| para_exclusion_08 | 55.6% | 55.9% | +0.3 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth, rubric |
| para_exclusion_09 | 100.0% | 98.7% | -1.3 |  |  |
| para_exclusion_10 | 100.0% | 98.7% | -1.3 |  |  |
| para_exclusion_11 | 100.0% | 98.6% | -1.4 |  |  |
| para_exclusion_12 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_13 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_14 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_15 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_16 | 55.6% | 55.0% | -0.6 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth, rubric |
| para_exclusion_17 | 100.0% | 98.9% | -1.1 |  |  |
| para_exclusion_18 | 100.0% | 98.8% | -1.2 |  |  |
| para_exclusion_19 | 94.4% | 93.8% | -0.6 | ledger_ground_truth | ledger_ground_truth |
| para_exclusion_20 | 100.0% | 98.7% | -1.3 |  |  |
| para_exclusion_21 | 94.4% | 91.7% | -2.7 | ledger_ground_truth | ledger_ground_truth, rubric |
| para_expense_01 | 55.6% | 55.0% | -0.6 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth, rubric |
| para_expense_02 | 100.0% | 98.6% | -1.4 |  |  |
| para_expense_03 | 100.0% | 99.0% | -1.0 |  |  |
| para_expense_04 | 100.0% | 99.0% | -1.0 |  |  |
| para_expense_05 | 100.0% | 98.5% | -1.5 |  |  |
| para_expense_06 | 100.0% | 99.0% | -1.0 |  |  |
| para_expense_07 | 55.6% | 56.4% | +0.8 | turn_expectations, ledger_ground_truth | turn_expectations, ledger_ground_truth, rubric |
| para_expense_08 | 100.0% | 98.8% | -1.2 |  |  |
| para_expense_09 | 100.0% | 98.7% | -1.3 |  |  |
| para_expense_10 | 100.0% | 98.7% | -1.3 |  |  |
| para_expense_11 | 100.0% | 98.9% | -1.1 |  |  |
| para_expense_12 | 100.0% | 98.8% | -1.2 |  |  |
| para_expense_13 | 100.0% | 98.3% | -1.7 |  | rubric |
| para_expense_14 | 100.0% | 98.8% | -1.2 |  |  |
| para_expense_15 | 94.4% | 90.8% | -3.7 | ledger_ground_truth | ledger_ground_truth, rubric |
| para_expense_16 | 100.0% | 98.9% | -1.1 |  |  |
| para_expense_17 | 100.0% | 98.8% | -1.2 |  |  |
| para_expense_18 | 100.0% | 98.3% | -1.7 |  | rubric |
| para_expense_19 | 100.0% | 98.1% | -1.9 |  | rubric |
| para_expense_20 | 100.0% | 98.7% | -1.3 |  |  |
| para_expense_21 | 100.0% | 98.7% | -1.3 |  |  |
| para_razz_01 | 100.0% | 98.1% | -1.9 |  | rubric |
| para_razz_02 | 76.9% | 98.6% | +21.7 | members_charged:proposed | rubric |
| para_razz_03 | 72.7% | 99.0% | +26.3 | members_charged:proposed |  |
| para_razz_04 | 76.9% | 99.0% | +22.1 | members_charged:proposed |  |
| para_razz_05 | 100.0% | 99.1% | -0.9 |  |  |

## In one run only

- only offline: para_razz_06, para_razz_07, para_razz_08, para_razz_09, para_razz_10, para_razz_11, para_razz_12, para_razz_13, para_razz_14, para_razz_15, para_razz_16, para_razz_17, para_razz_18, para_razz_19, para_razz_20, para_razz_21, para_razz_22, para_settle_01, para_settle_02, para_settle_03, para_settle_04, para_settle_05, para_settle_06, para_settle_07, para_settle_08, para_settle_09, para_settle_10, para_settle_11, para_settle_12, para_settle_13, para_settle_14, para_settle_15, para_settle_16, para_settle_17, para_settle_18, para_settle_19, para_settle_20, para_settle_21
