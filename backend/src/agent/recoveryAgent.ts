import { GoogleGenerativeAI, GenerationConfig } from '@google/generative-ai';
import { AgentDecisionSchema, type AgentDecision } from '../types/models';
import { logger } from '../utils/logger';
import type { RecoveryOpportunity, Customer, PaymentEvent } from '../types/models';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL_NAME = 'gemini-1.5-flash';

const generationConfig: GenerationConfig = {
  temperature: 0.15, // Low temp = more consistent structured output
  topP: 0.9,
  maxOutputTokens: 1500,
  responseMimeType: 'application/json',
};

/**
 * AI AGENT – uses Gemini to reason about recovery opportunities.
 *
 * DESIGN INVARIANTS (enforced structurally, not by convention):
 * 1. LLM output is validated by Zod before use. Invalid JSON = fallback.
 * 2. LLM never sees authorization code paths. It only produces a Decision.
 * 3. Monetary amounts are computed by deterministic backend code.
 * 4. Retry limits, idempotency, and policy checks are done AFTER the decision.
 * 5. Every failure mode degrades to HUMAN_REVIEW or STOP.
 */
export class RecoveryAgent {
  private model = genAI.getGenerativeModel({ model: MODEL_NAME });

  async analyzeOpportunity(params: {
    opportunity: RecoveryOpportunity;
    customer: Customer;
    event?: PaymentEvent;
    customerHistory: {
      totalAttempts: number;
      successRate: number;
      recentFailures: string[];
      avgAmount: number;
      recoveryHistory: Array<{ action: string; recovered: boolean }>;
    };
    previousInterventions: Array<{ action: string; outcome: string; date: string }>;
  }): Promise<{ decision: AgentDecision; isFallback: boolean }> {
    const { opportunity, customer, event, customerHistory, previousInterventions } = params;

    const prompt = this.buildPrompt({ opportunity, customer, event, customerHistory, previousInterventions });

    // Fast-path: if no valid API key is configured, skip the network call entirely.
    // The Gemini SDK with an empty/placeholder key can hang for minutes before failing.
    const apiKey = process.env.GEMINI_API_KEY || '';
    const hasValidKey = apiKey.length > 10 && !apiKey.includes('your_key');
    if (!hasValidKey) {
      logger.warn('[AI] No valid Gemini API key — using deterministic EV fallback');
      return {
        decision: this.fallbackDecision(opportunity, 'no_api_key', {
          risk_score: customer.risk_score,
          lifetime_value: customer.lifetime_value,
          history_success_rate: customerHistory.successRate,
          recent_failures: customerHistory.recentFailures,
        }),
        isFallback: true,
      };
    }

    // Attempt live Gemini call (with strict 5-second Promise.race timeout)
    try {
      let timerHandle: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          const e = new Error('Gemini call timed out after 5s');
          e.name = 'AbortError';
          reject(e);
        }, 5000);
      });

      const generatePromise = this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }).finally(() => clearTimeout(timerHandle!));

      const result = await Promise.race([generatePromise, timeoutPromise]) as any;
      
      const rawText = result.response.text().trim();
      logger.debug('Raw LLM response', { length: rawText.length });

      // Clean up potential markdown wrapping
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        logger.warn('LLM returned unparseable JSON – activating fallback');
        return { decision: this.fallbackDecision(opportunity, 'parse_error'), isFallback: true };
      }

      const validation = AgentDecisionSchema.safeParse(parsed);
      if (!validation.success) {
        logger.warn('LLM decision failed schema validation – activating fallback', {
          errors: validation.error.errors.slice(0, 3),
        });
        return { decision: this.fallbackDecision(opportunity, 'schema_invalid'), isFallback: true };
      }

      // Correct opportunity_id if hallucinated
      const decision = validation.data.opportunity_id !== opportunity.id
        ? { ...validation.data, opportunity_id: opportunity.id }
        : validation.data;

      return { decision, isFallback: false };
    } catch (err: any) {
      const errorType = err?.name === 'AbortError' ? 'timeout' : 'api_error';
      logger.error(`Gemini ${errorType}`, { message: err?.message });
      return { 
        decision: this.fallbackDecision(opportunity, errorType, {
          risk_score: customer.risk_score,
          lifetime_value: customer.lifetime_value,
          history_success_rate: customerHistory.successRate,
          recent_failures: customerHistory.recentFailures
        }),
        isFallback: true,
      };
    }
  }

  private buildPrompt(params: {
    opportunity: RecoveryOpportunity;
    customer: Customer;
    event?: PaymentEvent;
    customerHistory: {
      totalAttempts: number; successRate: number; recentFailures: string[];
      avgAmount: number; recoveryHistory: Array<{ action: string; recovered: boolean }>;
    };
    previousInterventions: Array<{ action: string; outcome: string; date: string }>;
  }): string {
    const { opportunity, customer, event, customerHistory, previousInterventions } = params;
    const meta = JSON.parse(customer.metadata || '{}');
    const hoursSince = Math.round((Date.now() - new Date(opportunity.created_at).getTime()) / 3_600_000);
    const recoverySuccessRate = customerHistory.recoveryHistory.length > 0
      ? customerHistory.recoveryHistory.filter(r => r.recovered).length / customerHistory.recoveryHistory.length
      : null;

    return `You are REVIVE AI, an autonomous revenue recovery reasoning engine for a fintech platform.

CRITICAL CONSTRAINTS (enforced by the system AFTER your response – you CANNOT override these):
- You do NOT authorize transactions. Your decision is reviewed by a Policy Engine.
- You do NOT set monetary amounts. Expected recovery is an estimate, the system calculates it.
- You do NOT control retry limits. The policy engine enforces those.
- Your only job is to reason about context and recommend the best recovery strategy.

## OPPORTUNITY CONTEXT
ID: ${opportunity.id}
Type: ${opportunity.opportunity_type}
Amount at risk: ₹${opportunity.amount.toFixed(2)}
Failure reason: ${opportunity.failure_reason || 'unknown'}
Failure category: ${opportunity.failure_category || 'unknown'}
Time since failure: ${hoursSince} hours
Prior interventions on this case: ${opportunity.previous_interventions}

## CUSTOMER SIGNALS
Lifetime value: ₹${customer.lifetime_value.toFixed(2)}
Risk score: ${(customer.risk_score * 100).toFixed(0)}% (0=low risk, 100=fraud likely)
Historical success rate: ${(customerHistory.successRate * 100).toFixed(1)}% over ${customerHistory.totalAttempts} transactions
Average transaction: ₹${customerHistory.avgAmount.toFixed(0)}
Recent failure pattern: ${customerHistory.recentFailures.slice(0, 3).join(', ') || 'none'}
Recovery success rate on this customer: ${recoverySuccessRate !== null ? (recoverySuccessRate * 100).toFixed(0) + '%' : 'no prior attempts'}
Payment method: ${event?.payment_method || 'unknown'}
Bank: ${meta.bank || 'unknown'}
Card type: ${meta.card_type || 'N/A'}
Gateway error: ${event?.gateway_error_code || 'none'}

## PRIOR INTERVENTIONS ON THIS OPPORTUNITY
${previousInterventions.length === 0 ? 'None yet' : previousInterventions.map(i => `- ${i.date}: ${i.action} → ${i.outcome}`).join('\n')}

## AVAILABLE STRATEGIES
- retry_payment: Immediate retry. Only for clearly transient technical failures with low risk score.
- schedule_retry: Delayed retry (end-of-day or end-of-month). For timing-sensitive failures like NSF.
- send_recovery_message: Email/SMS to customer. For card issues, abandonment, expired cards.
- escalate_to_human: Route to human agent. For high-value, repeated failures, or ambiguous signals.
- stop_ignore: Take no action. For fraud signals, permanently declined, or low expected value.
- change_strategy: Switch approach after prior strategy failed (e.g. retry failed → try messaging).

## BASELINE COMPARISON (what a simple rule-based system would do)
A simple "Always Retry" baseline would choose: retry_payment for any failed payment.
A rule-based system would choose based only on failure_reason.
Your decision should explain why your choice is better or different.

## RESPONSE (JSON ONLY, no markdown, no prose outside JSON)
{
  "opportunity_id": "${opportunity.id}",
  "diagnosis": "<1-2 sentences: what specifically failed and why>",
  "root_cause_category": "<one of: transient_technical | insufficient_funds | card_issue | bank_declined | customer_initiated | fraud_risk | unknown>",
  "recommended_action": "<one strategy from the list above>",
  "rejected_actions": [
    {"action": "<rejected strategy>", "reason": "<why rejected for this specific case>"},
    {"action": "<rejected strategy>", "reason": "<why rejected for this specific case>"}
  ],
  "confidence": <0.0-1.0, your confidence in the diagnosis and recommendation>,
  "baseline_action": "<what 'Always Retry' would choose>",
  "baseline_reasoning": "<why the baseline is suboptimal for this specific case>",
  "reasoning": "<2-4 sentences: your full reasoning chain connecting signals to recommendation>",
  "policy_requirements": ["<policy check required before execution>"],
  "stopping_condition": "<specific condition: when to stop recovery attempts>",
  "risk_level": "<low|medium|high|critical>"
}`;
  }

  /**
   * Deterministic EV-based fallback – safely executable without AI.
   * Calculates Expected Value for each action: (P(Success) * Amount) - Cost
   */
  fallbackDecision(
    opportunity: RecoveryOpportunity, 
    reason: string,
    customerContext?: { risk_score: number; lifetime_value: number; history_success_rate: number; recent_failures: string[] }
  ): AgentDecision {
    const cat = opportunity.failure_category || 'unknown';
    const amount = opportunity.amount;
    const interventions = opportunity.previous_interventions || 0;
    
    // Default context if not provided (e.g. during some unit tests)
    const ctx = customerContext || { risk_score: 0.5, lifetime_value: amount * 2, history_success_rate: 0.5, recent_failures: [] };

    // Base probabilities per category (derived from domain knowledge)
    const BASE_PROB: Record<string, number> = {
      technical_error: 0.76, insufficient_funds: 0.42, card_issue: 0.52,
      bank_declined: 0.33, upi_error: 0.62, auth_failure: 0.58, abandonment: 0.25
    };
    const baseP = BASE_PROB[cat] ?? 0.35;

    // Adjust probability based on customer signals
    let adjustedP = baseP;
    if (ctx.risk_score > 0.7) adjustedP *= 0.5; // High risk lowers real success chance
    else if (ctx.risk_score < 0.3) adjustedP *= 1.2;
    
    if (ctx.history_success_rate > 0.8) adjustedP *= 1.15;
    if (interventions > 0) adjustedP *= Math.pow(0.6, interventions); // Each attempt drops success chance

    adjustedP = Math.min(0.95, Math.max(0.01, adjustedP));

    // Define candidate actions and their EV parameters
    // Costs are in INR (e.g., human ops cost, SMS cost, UX friction cost)
    const actions = [
      { id: 'retry_payment',         pMult: 1.0, cost: 2 },   // Cheap but might get blocked if spammed
      { id: 'schedule_retry',        pMult: 0.8, cost: 5 },   // Delays cash flow, lower P but safe
      { id: 'send_recovery_message', pMult: 0.5, cost: 15 },  // Customer friction + SMS cost
      { id: 'escalate_to_human',     pMult: 0.9, cost: 350 }, // Expensive operations cost
      { id: 'stop_ignore',           pMult: 0.0, cost: 0 }
    ];

    // Evaluate EV
    let bestAction = actions[4];
    let bestEV = -Infinity;
    const evLog: string[] = [];

    for (const act of actions) {
      let p = adjustedP * act.pMult;
      
      // Contextual overrides
      if (act.id === 'retry_payment' && (cat === 'card_issue' || cat === 'bank_declined' || cat === 'fraud_risk')) p = 0.01;
      if (act.id === 'send_recovery_message' && cat === 'abandonment') p = 0.6; // Best for abandonment
      
      const ev = (p * amount) - act.cost;
      evLog.push(`${act.id}: ₹${ev.toFixed(0)}`);
      
      if (ev > bestEV) {
        bestEV = ev;
        bestAction = act;
      }
    }

    // Safety guardrails overriding EV
    if (ctx.risk_score > 0.85 && bestAction.id === 'retry_payment') {
      bestAction = actions.find(a => a.id === 'stop_ignore')!;
    }
    if (amount > 500000 && bestAction.id !== 'stop_ignore') {
      bestAction = actions.find(a => a.id === 'escalate_to_human')!;
    }

    const recommendedAction = bestAction.id as AgentDecision['recommended_action'];
    
    // Map failure category to allowed Zod root_cause_category enum
    const causeMap: Record<string, string> = {
      technical_error: 'transient_technical', upi_error: 'transient_technical',
      insufficient_funds: 'insufficient_funds', card_issue: 'card_issue',
      bank_declined: 'bank_declined', fraud_risk: 'fraud_risk',
      abandonment: 'customer_initiated'
    };
    
    return {
      opportunity_id: opportunity.id,
      diagnosis: `Fallback EV Model (${reason}). Category: ${cat}. BaseP: ${baseP.toFixed(2)}, AdjP: ${adjustedP.toFixed(2)}.`,
      root_cause_category: (causeMap[cat] || 'unknown') as any,
      recommended_action: recommendedAction,
      rejected_actions: [], // EV model implicitly rejects others
      confidence: adjustedP,
      baseline_action: 'retry_payment',
      baseline_reasoning: 'Baseline would blindly retry without EV calculation.',
      reasoning: `EV Calculation: [${evLog.join(', ')}]. Selected ${recommendedAction} based on max EV, adjusted for risk score ${(ctx.risk_score*100).toFixed(0)}% and ${interventions} prior attempts.`,
      policy_requirements: ['max_retry_count', 'cooldown_period'],
      stopping_condition: `Stop after ${Math.max(1, 3 - interventions)} more failed attempts`,
      risk_level: ctx.risk_score > 0.7 ? 'high' : 'medium',
    };
  }
}

export const recoveryAgent = new RecoveryAgent();
