import { getDb } from '../db/database';
import type { RecoveryOpportunity, PaymentEvent } from '../types/models';
import { v4 as uuidv4 } from 'uuid';
import { auditService } from './auditService';

/**
 * Revenue Risk Detector – scans payment events and produces recovery opportunities.
 * Purely deterministic – no AI involved at this stage.
 */
export class RiskDetector {
  /**
   * Scan unprocessed payment events and create recovery opportunities.
   * Returns count of opportunities created.
   */
  detectOpportunities(batchSize = 500, specificEventId?: string): { created: number; totalAtRisk: number } {
    const db = getDb();
    const now = new Date().toISOString();

    // Find failed/abandoned events without existing opportunities
    let query = `
      SELECT pe.* FROM payment_events pe
      LEFT JOIN recovery_opportunities ro ON ro.payment_event_id = pe.id
      WHERE pe.status IN ('failed', 'abandoned', 'overdue') AND ro.id IS NULL
    `;
    const params: (string | number)[] = [];
    
    if (specificEventId) {
      query += ` AND pe.id = ?`;
      params.push(specificEventId);
    }
    
    query += ` LIMIT ?`;
    params.push(batchSize);

    const events = db.prepare(query).all(...params) as unknown as PaymentEvent[];

    let created = 0;
    let totalAtRisk = 0;

    const insert = db.prepare(`
      INSERT INTO recovery_opportunities
        (id, customer_id, payment_event_id, opportunity_type, amount, estimated_recoverable,
         priority_score, status, failure_reason, failure_category, previous_interventions, created_at, updated_at, split)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?)
    `);

    for (const event of events) {
      const { type, category } = this.classifyEvent(event);
      const recoverability = this.estimateRecoverability(event, category);
      const priority = this.calculatePriority(event, recoverability);

      const oppId = uuidv4();
      insert.run(
        oppId, event.customer_id, event.id, type,
        event.amount, event.amount * recoverability,
        priority, event.failure_reason || 'unknown', category,
        now, now, (event as any).split || 'train'
      );

      totalAtRisk += event.amount;
      created++;
    }

    return { created, totalAtRisk };
  }

  private classifyEvent(event: PaymentEvent): { type: string; category: string } {
    if (event.event_type === 'checkout_abandoned') {
      return { type: 'checkout_abandonment', category: 'abandonment' };
    }
    if (event.event_type === 'subscription_failed') {
      return { type: 'subscription_failure', category: this.categorizeFailure(event.failure_reason) };
    }
    if (event.event_type === 'receivable_overdue') {
      return { type: 'overdue_receivable', category: 'overdue' };
    }
    return { type: 'payment_failure', category: this.categorizeFailure(event.failure_reason) };
  }

  private categorizeFailure(reason?: string): string {
    if (!reason) return 'unknown';
    const r = reason.toLowerCase();
    if (r.includes('insufficient') || r.includes('funds') || r.includes('balance')) return 'insufficient_funds';
    if (r.includes('expired') || r.includes('card')) return 'card_issue';
    if (r.includes('timeout') || r.includes('network') || r.includes('gateway')) return 'technical_error';
    if (r.includes('blocked') || r.includes('declined') || r.includes('fraud')) return 'bank_declined';
    if (r.includes('upi') || r.includes('vpa')) return 'upi_error';
    if (r.includes('otp') || r.includes('authentication') || r.includes('3ds')) return 'auth_failure';
    return 'other';
  }

  private estimateRecoverability(event: PaymentEvent, category: string): number {
    const rates: Record<string, number> = {
      technical_error: 0.78,
      insufficient_funds: 0.45,
      card_issue: 0.55,
      bank_declined: 0.35,
      upi_error: 0.70,
      auth_failure: 0.60,
      abandonment: 0.30,
      overdue: 0.65,
      other: 0.40,
      unknown: 0.40,
    };
    return rates[category] ?? 0.40;
  }

  private calculatePriority(event: PaymentEvent, recoverability: number): number {
    // Priority = normalized(amount) * recoverability * urgency
    const normalizedAmount = Math.min(event.amount / 100000, 1.0); // cap at 1L
    const ageHours = (Date.now() - new Date(event.occurred_at).getTime()) / 3_600_000;
    const urgency = Math.max(0.1, 1 - ageHours / 168); // decays over 7 days
    return Math.min(1.0, normalizedAmount * 0.4 + recoverability * 0.4 + urgency * 0.2);
  }
}

export const riskDetector = new RiskDetector();
