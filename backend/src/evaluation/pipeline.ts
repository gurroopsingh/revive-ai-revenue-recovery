/**
 * REVIVE AI Evaluation Pipeline v3
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { initDatabase, getDb } from '../db/database';
import { recoveryAgent } from '../agent/recoveryAgent';
import { policyEngine } from '../policies/policyEngine';
import { v4 as uuidv4 } from 'uuid';
import { AgentDecisionSchema } from '../types/models';

class SeededRandom {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

const CATEGORY_RATES: Record<string, number> = {
  technical_error:   0.76, insufficient_funds:0.42, card_issue:        0.52,
  bank_declined:     0.33, upi_error:         0.62, auth_failure:      0.58,
  abandonment:       0.25, overdue:           0.60, unknown:           0.35,
};

const RULE_BASED_ACTION: Record<string, string> = {
  technical_error:    'retry_payment',
  insufficient_funds: 'schedule_retry',
  card_issue:         'send_recovery_message',
  bank_declined:      'schedule_retry',
  upi_error:          'retry_payment',
  auth_failure:       'send_recovery_message',
  abandonment:        'send_recovery_message',
  fraud_risk:         'stop_ignore',
  unknown:            'escalate_to_human',
};

// The true environment simulator — exactly the same for all strategies
function simulateEnvironmentOutcome(opp: any, action: string, rng: SeededRandom): { success: boolean, amount: number, cost: number } {
  const costs: Record<string, number> = {
    'retry_payment': 2, 'schedule_retry': 5, 'send_recovery_message': 15, 'escalate_to_human': 350, 'stop_ignore': 0
  };
  const cost = costs[action] ?? 10;
  
  if (action === 'stop_ignore') return { success: false, amount: 0, cost };

  const baseRate = CATEGORY_RATES[opp.failure_category || 'unknown'] ?? 0.35;
  const riskPenalty = opp.risk_score > 0.6 ? 0.15 : (opp.risk_score < 0.3 ? -0.1 : 0);
  let p = Math.max(0, Math.min(0.95, baseRate - riskPenalty));
  
  if (opp.previous_interventions > 0) p *= Math.pow(0.6, opp.previous_interventions);

  if (action === 'schedule_retry') p *= 0.8;
  if (action === 'send_recovery_message') p *= 0.5;
  if (action === 'send_recovery_message' && opp.failure_category === 'abandonment') p = 0.6;
  if (action === 'retry_payment' && ['card_issue', 'bank_declined', 'fraud_risk'].includes(opp.failure_category)) p = 0.01;
  if (action === 'escalate_to_human') p *= 0.9;

  const success = rng.next() < p;
  // Successful transaction yields amount, but we always subtract cost
  return { success, amount: success ? opp.amount : 0, cost };
}

interface StrategyResult {
  name: string;
  description: string;
  total_cases: number;
  attempted: number;
  recovered_count: number;
  blocked_count: number;
  total_at_risk_inr: number;
  total_recovered_inr: number;
  total_cost_inr: number;
  net_revenue_inr: number;
  recovery_rate_pct: number;
}

async function runStrategy(
  name: string, description: string, testOpps: any[], 
  actionSelector: (opp: any) => string, seed: number
): Promise<StrategyResult> {
  const rng = new SeededRandom(seed);
  let recovered_count = 0;
  let attempted = 0;
  let blocked_count = 0;
  let total_recovered_inr = 0;
  let total_cost_inr = 0;
  let total_at_risk_inr = 0;

  for (const opp of testOpps) {
    total_at_risk_inr += opp.amount;
    const action = actionSelector(opp);
    
    // Safety Policy applied to ALL strategies for fairness (e.g. amounts > 5L require human)
    let isBlocked = false;
    if (opp.amount > 500000 && action !== 'escalate_to_human' && action !== 'stop_ignore') isBlocked = true;
    if (opp.risk_score > 0.85 && action === 'retry_payment') isBlocked = true;
    
    if (isBlocked) {
      blocked_count++;
      continue;
    }

    if (action !== 'stop_ignore') {
      attempted++;
    }

    const outcome = simulateEnvironmentOutcome(opp, action, rng);
    total_cost_inr += outcome.cost;
    if (outcome.success) {
      recovered_count++;
      total_recovered_inr += outcome.amount;
    }
  }

  const net_revenue = total_recovered_inr - total_cost_inr;

  return {
    name, description, total_cases: testOpps.length, attempted, recovered_count, blocked_count,
    total_at_risk_inr, total_recovered_inr, total_cost_inr, net_revenue_inr: net_revenue,
    recovery_rate_pct: (recovered_count / testOpps.length) * 100,
  };
}

async function runEvaluation(): Promise<void> {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const isAblation = args.includes('--ablation');

  console.log('\n🔬 REVIVE AI Evaluation Pipeline v3');
  console.log('='.repeat(60));

  initDatabase();
  const db = getDb();

  const testOpps = db.prepare(`
    SELECT ro.*, c.risk_score, c.lifetime_value, 
           c.successful_transactions * 1.0 / MAX(c.total_transactions, 1) as history_success_rate
    FROM recovery_opportunities ro
    JOIN customers c ON c.id = ro.customer_id
    WHERE ro.split = 'test'
  `).all() as any[];

  if (testOpps.length === 0) {
    console.error('❌ No test cases. Run `npm run seed` first.');
    process.exit(1);
  }
  console.log(`   Test split: ${testOpps.length.toLocaleString()} cases`);

  // --- BASELINES ---
  const alwaysRetry = await runStrategy('Always Retry', 'Blindly retry everything', testOpps, () => 'retry_payment', 11111);
  const ruleBased = await runStrategy('Rule-Based', 'Category to Action map', testOpps, 
    (opp) => RULE_BASED_ACTION[opp.failure_category || 'unknown'] || 'escalate_to_human', 22222
  );

  // --- REVIVE FALLBACK ---
  const reviveFallback = await runStrategy('REVIVE AI (Fallback)', 'EV deterministic model', testOpps, (opp) => {
    const decision = recoveryAgent.fallbackDecision(opp, 'eval', {
      risk_score: opp.risk_score, lifetime_value: opp.lifetime_value, 
      history_success_rate: opp.history_success_rate, recent_failures: []
    });
    return decision.recommended_action;
  }, 33333);

  // --- LIVE AI (if requested) ---
  let reviveLive: StrategyResult | null = null;
  if (isLive) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_key_here') {
      console.error('❌ GEMINI_API_KEY not configured. Cannot run live evaluation.');
      process.exit(1);
    }
    console.log('\n   🧠 Running Live Gemini AI on sample (250 cases)...');
    
    // Use stable sample for live eval
    const liveSample = testOpps.slice(0, 250);
    let successCalls = 0;
    let fallbackCalls = 0;

    reviveLive = await runStrategy('REVIVE AI (Live Gemini)', 'LLM Contextual Reasoning', liveSample, (opp) => {
      // Because we run async inside the sync runner simulation, this requires a workaround.
      // But we can't do async inside runStrategy selector trivially. 
      // Instead, we will simulate this by pre-computing actions.
      return 'escalate_to_human'; // Placeholder logic implementation below
    }, 44444);
    
    // We will do actual async pre-computation for live:
    const liveActions = new Map<string, string>();
    for (const opp of liveSample) {
      const { decision, isFallback } = await recoveryAgent.analyzeOpportunity({
        opportunity: opp,
        customer: { id: opp.customer_id, risk_score: opp.risk_score, lifetime_value: opp.lifetime_value } as any,
        customerHistory: { totalAttempts: 10, successRate: opp.history_success_rate, recentFailures: [], avgAmount: opp.amount, recoveryHistory: [] },
        previousInterventions: []
      });
      liveActions.set(opp.id, decision.recommended_action);
      if (isFallback) fallbackCalls++;
      else successCalls++;
      process.stdout.write(`   API Calls: ${successCalls + fallbackCalls}/250\r`);
      await new Promise(r => setTimeout(r, 250)); // Rate limit
    }
    
    reviveLive = await runStrategy('REVIVE AI (Live Gemini)', `Live LLM. Sample: 250`, liveSample, (opp) => liveActions.get(opp.id) || 'stop_ignore', 44444);
    (reviveLive as any).successCalls = successCalls;
    (reviveLive as any).fallbackCalls = fallbackCalls;
  }

  // --- PRINT RESULTS ---
  const strategies = [alwaysRetry, ruleBased, reviveFallback];
  if (reviveLive) strategies.push(reviveLive);

  console.log(`\n${'Strategy'.padEnd(25)} ${'Cases'.padStart(6)} ${'Net Rev (₹)'.padStart(14)} ${'Recov Rate'.padStart(12)} ${'Blocked'.padStart(8)}`);
  console.log('-'.repeat(70));
  for (const s of strategies) {
    console.log(`${s.name.padEnd(25)} ${s.total_cases.toString().padStart(6)} ${(Math.round(s.net_revenue_inr).toLocaleString()).padStart(14)} ${s.recovery_rate_pct.toFixed(1).padStart(11)}% ${s.blocked_count.toString().padStart(8)}`);
  }

  const upliftVsAR = reviveFallback.net_revenue_inr - alwaysRetry.net_revenue_inr;
  const upliftVsRB = reviveFallback.net_revenue_inr - ruleBased.net_revenue_inr;
  
  console.log(`\n📈 REVIVE vs Always Retry: +₹${Math.round(upliftVsAR).toLocaleString()} Net Revenue`);
  console.log(`   REVIVE vs Rule-Based:   ${upliftVsRB >= 0 ? '+' : '-'}₹${Math.round(Math.abs(upliftVsRB)).toLocaleString()} Net Revenue`);
  
  if (upliftVsRB > 0) {
    console.log(`   ✅ REVIVE safely outperforms Rule-Based by calculating Expected Value.`);
  } else {
    console.log(`   ❌ REVIVE underperforms Rule-Based.`);
  }

  // --- ABLATION STUDY ---
  if (isAblation) {
    console.log('\n   🧪 Running Ablation Study...');
    const noHistory = await runStrategy('REVIVE (No History)', '', testOpps, (opp) => 
      recoveryAgent.fallbackDecision(opp, 'ablation', { risk_score: opp.risk_score, lifetime_value: opp.lifetime_value, history_success_rate: 0.5, recent_failures: [] }).recommended_action
    , 33333);
    const noRisk = await runStrategy('REVIVE (No Risk Score)', '', testOpps, (opp) => 
      recoveryAgent.fallbackDecision(opp, 'ablation', { risk_score: 0.5, lifetime_value: opp.lifetime_value, history_success_rate: opp.history_success_rate, recent_failures: [] }).recommended_action
    , 33333);
    
    let md = `# REVIVE AI — Ablation Study\n\n`;
    md += `| Strategy | Net Revenue | Impact |\n|---|---|---|\n`;
    md += `| Full REVIVE | ₹${Math.round(reviveFallback.net_revenue_inr).toLocaleString()} | - |\n`;
    md += `| Without Risk Score | ₹${Math.round(noRisk.net_revenue_inr).toLocaleString()} | ${Math.round(noRisk.net_revenue_inr - reviveFallback.net_revenue_inr).toLocaleString()} |\n`;
    md += `| Without History | ₹${Math.round(noHistory.net_revenue_inr).toLocaleString()} | ${Math.round(noHistory.net_revenue_inr - reviveFallback.net_revenue_inr).toLocaleString()} |\n`;
    fs.writeFileSync(path.resolve(process.cwd(), '../evaluation/ablation.md'), md);
    console.log(`   ✅ Ablation study saved to evaluation/ablation.md`);
  }

  // Save regular eval
  const output = {
    generated_at: new Date().toISOString(),
    eval_mode: isLive ? 'live_gemini' : 'deterministic_fallback',
    test_split_size: testOpps.length,
    strategies,
    uplift: {
      revive_vs_always_retry: { net_revenue_diff: upliftVsAR, recovery_rate_pp: reviveFallback.recovery_rate_pct - alwaysRetry.recovery_rate_pct },
      revive_vs_rule_based: { net_revenue_diff: upliftVsRB, recovery_rate_pp: reviveFallback.recovery_rate_pct - ruleBased.recovery_rate_pct }
    }
  };
  fs.writeFileSync(path.resolve(process.cwd(), '../evaluation/results.json'), JSON.stringify(output, null, 2));

  if (isLive) {
    fs.writeFileSync(path.resolve(process.cwd(), '../evaluation/live_results.json'), JSON.stringify(output, null, 2));
    const md = `# REVIVE AI — Live Evaluation\nSample Size: 250\nDate: ${output.generated_at}\nModel: Gemini 1.5 Flash\nAPI Calls: ${(reviveLive as any).successCalls} successful, ${(reviveLive as any).fallbackCalls} fallbacks.\n\nNet Revenue: ₹${Math.round(reviveLive!.net_revenue_inr).toLocaleString()}`;
    fs.writeFileSync(path.resolve(process.cwd(), '../evaluation/live_report.md'), md);
  }

  process.exit(0);
}

runEvaluation().catch(err => { console.error('Evaluation failed:', err); process.exit(1); });
