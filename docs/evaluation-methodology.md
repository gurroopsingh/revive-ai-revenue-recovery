# REVIVE AI — Evaluation Methodology

This document details the rigorous approach used to evaluate REVIVE AI against simpler industry baselines, avoiding data leakage and producing an honest, defensible benchmark.

## 1. Data Split Architecture
The synthetic 50,000 payment event dataset is strictly split at seed time (seed=42):
- **TRAIN (70%)**: Used for exploratory data analysis, defining category-specific probabilities, and identifying optimal strategy heuristics.
- **DEV (15%)**: Used to select thresholds (e.g., risk > 0.85 triggers stop_ignore) and tune prompt structures.
- **TEST (15% — 4,691 cases)**: **Held out.** Never touched during model/strategy development. The evaluation pipeline reads this split *only* at benchmark execution.

## 2. The Evaluation Simulator
To ensure absolute fairness, REVIVE, Rule-Based, and Always-Retry strategies are evaluated in the *exact same simulated environment*. 

### Expected Value (EV) Model
Instead of merely optimizing for "Number of Recovered Transactions", we optimize for **Net Recovered Revenue**:

`Net Revenue = (Probability(Success | Context) * Amount) - Intervention Cost`

Intervention costs:
- `retry_payment`: ₹2 (cheap, but risks bank blocks)
- `schedule_retry`: ₹5 (delays cash flow)
- `send_recovery_message`: ₹15 (SMS costs, UX friction)
- `escalate_to_human`: ₹350 (operations overhead)
- `stop_ignore`: ₹0

### Real-World Penalty Fair Play
If a customer has a `risk_score` of 0.80, their real-world probability of recovery drops significantly.
In our simulation (`pipeline.ts`), the environment explicitly applies a `riskPenalty` to the success chance of the action, *regardless of which strategy suggested it*. This prevents naive "Always Retry" baselines from succeeding on transactions that would realistically fail or cause chargebacks.

## 3. Fallback vs. Live AI
The architecture defines two distinct modes:

1. **REVIVE Safe Fallback**: A deterministic Expected Value (EV) engine that uses category, risk score, and historical success rate to estimate EV and choose an action. Runs offline instantly.
2. **REVIVE Live AI**: Gemini 1.5 Flash uses contextual reasoning to diagnose root causes and select an action. The output is validated by a Zod schema and piped through the same Policy Engine.

The `npm run evaluate` benchmark strictly evaluates the **Safe Fallback**.
We explicitly label this in the dashboard and logs, so we never falsely claim that deterministic fallback numbers are "LLM reasoning numbers."

## 4. Ablation Study
To prove that contextual intelligence provides the uplift, we run an ablation study (`npm run evaluate --ablation`), selectively blinding the fallback model to specific features:
- **No Risk Score**: Forces the model to assume average risk, causing it to over-attempt on fraudulent users.
- **No History**: Ignores customer historical success rate, causing it to miss strong signals for reliable customers.
- **Full Context**: Achieves the highest net revenue by correctly balancing expected value across all signals.
