import { Router } from 'express';
import { getDb } from '../db/database';
import { auditService } from '../services/auditService';

export const opportunitiesRouter = Router();

// GET /api/opportunities - list with filters
opportunitiesRouter.get('/', (req, res) => {
  const db = getDb();
  const { status, type, page = '1', limit = '20' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = '1=1';
  const params: (string | number)[] = [];
  if (status) { where += ' AND ro.status = ?'; params.push(status); }
  if (type) { where += ' AND ro.opportunity_type = ?'; params.push(type); }

  const total = (db.prepare(`
    SELECT COUNT(*) as cnt FROM recovery_opportunities ro WHERE ${where}
  `).get(...params) as { cnt: number }).cnt;

  const items = db.prepare(`
    SELECT ro.*,
           c.name as customer_name, c.email as customer_email,
           c.risk_score, c.lifetime_value,
           ad.recommended_action, ad.confidence, ad.diagnosis, ad.reasoning, ad.risk_level,
           pe.payment_method, pe.gateway_error_code
    FROM recovery_opportunities ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN agent_decisions ad ON ad.opportunity_id = ro.id AND ad.status NOT IN ('blocked')
    LEFT JOIN payment_events pe ON pe.id = ro.payment_event_id
    WHERE ${where}
    ORDER BY ro.priority_score DESC, ro.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ total, page: parseInt(page), limit: parseInt(limit), items });
});

// GET /api/opportunities/:id - case detail
opportunitiesRouter.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const opportunity = db.prepare(`
    SELECT ro.*,
           c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
           c.risk_score, c.lifetime_value, c.total_transactions, c.successful_transactions,
           pe.payment_method, pe.gateway_error_code, pe.occurred_at as event_occurred_at
    FROM recovery_opportunities ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN payment_events pe ON pe.id = ro.payment_event_id
    WHERE ro.id = ?
  `).get(id);

  if (!opportunity) {
    res.status(404).json({ error: 'Opportunity not found' });
    return;
  }

  const decisions = db.prepare(`
    SELECT ad.*, GROUP_CONCAT(pc.check_name || ':' || pc.passed || ':' || COALESCE(pc.reason,''), '|') as checks_raw
    FROM agent_decisions ad
    LEFT JOIN policy_checks pc ON pc.decision_id = ad.id
    WHERE ad.opportunity_id = ?
    GROUP BY ad.id
    ORDER BY ad.created_at DESC
  `).all(id);

  const actions = db.prepare(`
    SELECT * FROM recovery_actions WHERE opportunity_id = ? ORDER BY created_at ASC
  `).all(id);

  const auditTrail = auditService.getTrail(id as string);

  res.json({ opportunity, decisions, actions, audit_trail: auditTrail });
});
