import { Router } from 'express';
import { getDb } from '../db/database';
import fs from 'fs';
import path from 'path';

export const analyticsRouter = Router();

analyticsRouter.get('/funnel', (_req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_detected,
      SUM(CASE WHEN status != 'ignored' THEN 1 ELSE 0 END) as assessed,
      SUM(CASE WHEN status IN ('in_progress','awaiting_approval','recovered','failed','blocked') THEN 1 ELSE 0 END) as processed,
      SUM(CASE WHEN status NOT IN ('blocked','ignored') THEN 1 ELSE 0 END) as attempted,
      SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END) as recovered,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
      SUM(amount) as total_at_risk,
      SUM(CASE WHEN status = 'recovered' THEN estimated_recoverable ELSE 0 END) as total_recovered_value
    FROM recovery_opportunities
  `).get() as Record<string, number>;
  res.json(stats);
});

analyticsRouter.get('/timeline', (_req, res) => {
  const db = getDb();
  const timeline = db.prepare(`
    SELECT DATE(ra.executed_at) as date, SUM(ra.outcome_amount) as recovered,
           COUNT(*) as actions, SUM(CASE WHEN ra.status='success' THEN 1 ELSE 0 END) as successes
    FROM recovery_actions ra
    WHERE ra.executed_at IS NOT NULL
    GROUP BY DATE(ra.executed_at) ORDER BY date ASC
  `).all();
  res.json(timeline);
});

analyticsRouter.get('/by-failure-type', (_req, res) => {
  const db = getDb();
  const data = db.prepare(`
    SELECT ro.failure_category, COUNT(*) as count, SUM(ro.amount) as total_amount,
           SUM(CASE WHEN ro.status='recovered' THEN 1 ELSE 0 END) as recovered_count
    FROM recovery_opportunities ro
    GROUP BY ro.failure_category ORDER BY total_amount DESC
  `).all();
  res.json(data);
});

/**
 * Agent vs Baseline endpoint — reads from evaluation/results.json if available.
 * Falls back to live DB query for REVIVE stats when evaluation hasn't been run yet.
 */
analyticsRouter.get('/agent-vs-baseline', (_req, res) => {
  const db = getDb();

  // Try to load real evaluation results
  const evalPath = path.resolve(process.cwd(), '../evaluation/results.json');
  if (fs.existsSync(evalPath)) {
    try {
      const evalData = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
      const revive = evalData.strategies.find((s: any) => s.name.includes('REVIVE'));
      const ruleBased = evalData.strategies.find((s: any) => s.name.includes('Rule'));
      const alwaysRetry = evalData.strategies.find((s: any) => s.name.includes('Always'));

      // Supplement REVIVE stats with live DB data for display
      const liveRecovered = (db.prepare("SELECT COALESCE(SUM(outcome_amount),0) as s FROM recovery_actions WHERE status='success'").get() as any).s;

      return res.json({
        source: 'evaluation_results_json',
        eval_mode: evalData.eval_mode,
        last_run: evalData.generated_at,
        agent: {
          ...revive,
          live_recovered_inr: liveRecovered,
        },
        baseline_always_retry: alwaysRetry,
        baseline_rule_based: ruleBased,
        uplift: evalData.uplift?.revive_vs_always_retry,
        ai_decision_quality: evalData.ai_decision_quality,
      });
    } catch { /* fall through to live query */ }
  }

  // No evaluation run yet — compute live stats with note
  const agentStats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN ro.status='recovered' THEN 1 ELSE 0 END) as recovered,
           SUM(CASE WHEN ro.status='blocked' THEN 1 ELSE 0 END) as blocked_unsafe,
           COALESCE(SUM(ra.outcome_amount),0) as total_recovered_inr,
           AVG(ad.confidence) as avg_confidence
    FROM recovery_opportunities ro
    LEFT JOIN agent_decisions ad ON ad.opportunity_id = ro.id
    LEFT JOIN recovery_actions ra ON ra.opportunity_id = ro.id AND ra.status='success'
  `).get() as Record<string, number>;

  const agentRate = agentStats.total > 0 ? ((agentStats.recovered || 0) / agentStats.total) * 100 : 0;

  res.json({
    source: 'live_db',
    note: 'Run `npm run evaluate` in backend for reproducible baseline comparison',
    agent: { ...agentStats, recovery_rate: agentRate },
    baseline_always_retry: { recovery_rate: 34.9, description: 'Estimated — run `npm run evaluate` for exact numbers' },
    baseline_rule_based: { recovery_rate: 48.9, description: 'Estimated — run `npm run evaluate` for exact numbers' },
    uplift: { recovery_rate: agentRate - 34.9 },
  });
});

analyticsRouter.get('/precision', (_req, res) => {
  const db = getDb();
  const data = db.prepare(`
    SELECT COUNT(*) as total_actions,
           SUM(CASE WHEN ra.status='success' THEN 1 ELSE 0 END) as successful,
           SUM(CASE WHEN ra.status='failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN ra.status='blocked' THEN 1 ELSE 0 END) as blocked,
           COALESCE(SUM(ra.outcome_amount),0) as total_recovered,
           AVG(CASE WHEN ra.status='success' THEN 1.0 ELSE 0.0 END) as precision_rate
    FROM recovery_actions ra
  `).get() as Record<string, number>;
  res.json(data);
});
