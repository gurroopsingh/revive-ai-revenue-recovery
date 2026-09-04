import { getDb } from '../db/database';
import { v4 as uuidv4 } from 'uuid';

interface AuditEntry {
  opportunity_id?: string;
  decision_id?: string;
  action_id?: string;
  event_type: string;
  actor?: string;
  description: string;
  data?: Record<string, unknown>;
}

export const auditService = {
  async log(entry: AuditEntry): Promise<void> {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, opportunity_id, decision_id, action_id, event_type, actor, description, data, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      entry.opportunity_id || null,
      entry.decision_id || null,
      entry.action_id || null,
      entry.event_type,
      entry.actor || 'system',
      entry.description,
      JSON.stringify(entry.data || {}),
      new Date().toISOString()
    );
  },

  getTrail(opportunityId: string) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM audit_log WHERE opportunity_id = ? ORDER BY timestamp ASC
    `).all(opportunityId);
  },

  getRecent(limit = 100) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
    `).all(limit);
  },
};
