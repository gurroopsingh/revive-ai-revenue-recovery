import { Router } from 'express';
import { getDb } from '../db/database';
import { policyEngine } from '../policies/policyEngine';
import { logger } from '../utils/logger';

export const configRouter = Router();

// GET /api/config - get merchant config
configRouter.get('/', (_req, res) => {
  const config = policyEngine.getConfig();
  res.json(config);
});

// PUT /api/config - update merchant config
configRouter.put('/', (req, res) => {
  const db = getDb();
  const {
    max_retry_attempts,
    cooldown_hours,
    max_contact_per_week,
    max_transaction_limit,
    confidence_threshold,
    human_approval_threshold,
    kill_switch_enabled,
  } = req.body as Record<string, number | boolean>;

  db.prepare(`
    UPDATE merchant_config SET
      max_retry_attempts = COALESCE(?, max_retry_attempts),
      cooldown_hours = COALESCE(?, cooldown_hours),
      max_contact_per_week = COALESCE(?, max_contact_per_week),
      max_transaction_limit = COALESCE(?, max_transaction_limit),
      confidence_threshold = COALESCE(?, confidence_threshold),
      human_approval_threshold = COALESCE(?, human_approval_threshold),
      kill_switch_enabled = COALESCE(?, kill_switch_enabled),
      updated_at = ?
    WHERE id = 'default'
  `).run(
    (max_retry_attempts as number) ?? null,
    (cooldown_hours as number) ?? null,
    (max_contact_per_week as number) ?? null,
    (max_transaction_limit as number) ?? null,
    (confidence_threshold as number) ?? null,
    (human_approval_threshold as number) ?? null,
    kill_switch_enabled !== undefined ? (kill_switch_enabled ? 1 : 0) : null,
    new Date().toISOString()
  );

  policyEngine.reloadConfig();
  logger.info('Merchant config updated', { updated: req.body });

  res.json({ success: true, config: policyEngine.getConfig() });
});

// POST /api/config/kill-switch - toggle kill switch
configRouter.post('/kill-switch', (req, res) => {
  const db = getDb();
  const { enabled } = req.body as { enabled: boolean };
  db.prepare('UPDATE merchant_config SET kill_switch_enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), 'default');
  policyEngine.reloadConfig();
  logger.warn(`Kill switch ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ success: true, kill_switch_enabled: enabled });
});
