import { Router } from 'express';
import { recoveryWorkflow } from '../services/recoveryWorkflow';
import { riskDetector } from '../services/riskDetector';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

export const agentRouter = Router();

// POST /api/agent/run - process a single opportunity through the full pipeline
agentRouter.post('/run/:opportunityId', async (req, res, next) => {
  try {
    const { opportunityId } = req.params;
    const result = await recoveryWorkflow.processOpportunity(opportunityId);
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/agent/run-batch - process multiple pending opportunities
agentRouter.post('/run-batch', async (req, res, next) => {
  try {
    const { limit = 10 } = req.body as { limit?: number };
    const db = getDb();

    const pending = db.prepare(`
      SELECT id FROM recovery_opportunities WHERE status = 'pending'
      ORDER BY priority_score DESC LIMIT ?
    `).all(Math.min(limit, 50)) as { id: string }[];

    logger.info(`Running batch agent on ${pending.length} opportunities`);

    const results = [];
    for (const { id } of pending) {
      try {
        const result = await recoveryWorkflow.processOpportunity(id);
        results.push(result);
        // Small delay to respect API rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        logger.error(`Failed to process opportunity ${id}`, { err });
        results.push({ opportunityId: id, status: 'error', error: String(err) });
      }
    }

    res.json({
      success: true,
      processed: results.length,
      results,
      summary: {
        recovered: results.filter(r => r.status === 'recovered').length,
        blocked: results.filter(r => r.status === 'blocked').length,
        awaiting_approval: results.filter(r => r.status === 'awaiting_approval').length,
        failed: results.filter(r => r.status === 'failed').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/agent/approve/:actionId - approve a pending action
agentRouter.post('/approve/:actionId', async (req, res, next) => {
  try {
    const { actionId } = req.params;
    const { approved_by = 'merchant_admin' } = req.body as { approved_by?: string };
    await recoveryWorkflow.approveAction(actionId, approved_by);
    res.json({ success: true, message: 'Action approved and executed' });
  } catch (err) {
    next(err);
  }
});

// POST /api/agent/detect - run risk detection on new events
agentRouter.post('/detect', (req, res) => {
  const { batch_size = 500 } = req.body as { batch_size?: number };
  const result = riskDetector.detectOpportunities(batch_size);
  res.json({ success: true, ...result });
});
