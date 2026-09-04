# REVIVE AI — Evaluation Report
Generated: 2026-09-04T08:18:55.969Z | Seed: 42 | Mode: `deterministic_fallback`

> **Note:** Run with GEMINI_API_KEY set for live AI evaluation. Fallback results are reproducible.

## Results (Test Split: 4,691 cases)

| Strategy | Cases | Recovered | Recovery Rate | Precision | Blocked |
|---|---|---|---|---|---|
| REVIVE AI (Fallback) | 4,691 | 2,021 | 44.2% | 44.2% | 123 |
| Rule-Based | 4,691 | 2,296 | 48.9% | 48.9% | 0 |
| Always Retry | 4,691 | 1,624 | 34.6% | 34.6% | 0 |

## Uplift
| | vs Always Retry | vs Rule-Based |
|---|---|---|
| Recovery Rate | **+9.6pp** | **-4.7pp** |
| Unsafe Blocked | 123 | — |

## AI Decision Quality
- Decision accuracy: **60.8%**
- Avg confidence: **59%**
- decision_accuracy = fraction of cases where agent matched the domain-optimal strategy for that failure category

## Methodology
```
DATA FLOW (no leakage):
  Seed (seed=42) → 50,000 events with deterministic splits
  train (70%) / dev (15%) / test (15%)
  Risk detector runs on ALL splits at seed time → creates recovery_opportunities
  Evaluation clears any prior test-split decisions, then runs the agent fresh
  Agent uses: failure_category + customer risk score + prior interventions
  Agent does NOT use: test label, outcome ground truth, or recovery results

BASELINES:
  Always Retry: SeededRandom(11111), 35% base rate (industry reference)
  Rule-Based: SeededRandom(22222), per-category rates from CATEGORY_RATES map
  REVIVE: SeededRandom(33333) for outcome simulation; decisions from deterministic fallback logic

GROUND TRUTH:
  Simulated outcomes use per-category probability adjusted by customer risk score.
  This is synthetic — the system is a buildathon prototype, not a live integration.
  In production, outcomes would come from Razorpay webhook callbacks.

DECISION ACCURACY:
  Measures whether agent chose the domain-optimal action (OPTIMAL_ACTION map).
  This is separate from outcome success, which depends on the simulated payment outcome.
```

## Limitations
- Execution outcomes are simulated (no live Razorpay API)
- Baselines use domain-knowledge success rates, not A/B test data
- Fallback evaluation does not use live Gemini reasoning
