import { Router } from 'express';
import { getDb } from '../db/database';

export const dashboardRouter = Router();

dashboardRouter.get('/overview', (_req, res) => {
  const db = getDb();

  const atRisk = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM recovery_opportunities
    WHERE status NOT IN ('ignored')
  `).get() as { total: number }).total;

  const recoverable = (db.prepare(`
    SELECT COALESCE(SUM(estimated_recoverable), 0) as total FROM recovery_opportunities
    WHERE status IN ('pending', 'in_progress', 'awaiting_approval')
  `).get() as { total: number }).total;

  const recovered = (db.prepare(`
    SELECT COALESCE(SUM(outcome_amount), 0) as total FROM recovery_actions
    WHERE status = 'success'
  `).get() as { total: number }).total;

  const totalAttempted = (db.prepare(`
    SELECT COALESCE(SUM(estimated_recoverable), 0) as total FROM recovery_opportunities
    WHERE status IN ('recovered', 'failed', 'blocked')
  `).get() as { total: number }).total;

  const recoveryRate = totalAttempted > 0 ? recovered / totalAttempted : 0;

  const activeCases = (db.prepare(`
    SELECT COUNT(*) as cnt FROM recovery_opportunities WHERE status IN ('pending', 'in_progress')
  `).get() as { cnt: number }).cnt;

  const pendingApproval = (db.prepare(`
    SELECT COUNT(*) as cnt FROM recovery_actions WHERE status = 'awaiting_approval'
  `).get() as { cnt: number }).cnt;

  const blockedActions = (db.prepare(`
    SELECT COUNT(*) as cnt FROM recovery_opportunities WHERE status = 'blocked'
  `).get() as { cnt: number }).cnt;

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as cnt, SUM(amount) as total_amount
    FROM recovery_opportunities GROUP BY status
  `).all();

  const byType = db.prepare(`
    SELECT opportunity_type, COUNT(*) as cnt, SUM(amount) as total_amount,
           SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END) as recovered_cnt
    FROM recovery_opportunities GROUP BY opportunity_type
  `).all();

  res.json({
    overview: {
      revenue_at_risk: Math.round(atRisk * 100) / 100,
      recoverable_revenue: Math.round(recoverable * 100) / 100,
      revenue_recovered: Math.round(recovered * 100) / 100,
      recovery_rate: Math.round(recoveryRate * 10000) / 100,
      active_cases: activeCases,
      pending_approval: pendingApproval,
      blocked_actions: blockedActions,
    },
    by_status: byStatus,
    by_type: byType,
  });
});
