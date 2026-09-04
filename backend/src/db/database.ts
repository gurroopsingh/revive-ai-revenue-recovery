/**
 * Database wrapper using Node.js 24 built-in node:sqlite module.
 * Schema v2: adds split column, rejected_actions, root_cause_category,
 * is_fallback, is_ai_decision, is_demo_replay audit columns.
 */
// @ts-ignore – node:sqlite is experimental, types not yet in @types/node
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { logger } from '../utils/logger';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'revive.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

export function initDatabase(): void {
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'revive.db');
  _db = new DatabaseSync(dbPath);
  createSchema(_db);
  logger.info(`SQLite database at ${dbPath}`);
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      risk_score REAL DEFAULT 0.5,
      lifetime_value REAL DEFAULT 0,
      total_transactions INTEGER DEFAULT 0,
      successful_transactions INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL,
      payment_method TEXT,
      failure_reason TEXT,
      gateway_error_code TEXT,
      occurred_at TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      split TEXT DEFAULT 'train'
    );

    CREATE TABLE IF NOT EXISTS recovery_opportunities (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      payment_event_id TEXT,
      opportunity_type TEXT NOT NULL,
      amount REAL NOT NULL,
      estimated_recoverable REAL NOT NULL,
      priority_score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      failure_category TEXT,
      previous_interventions INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      split TEXT DEFAULT 'train'
    );

    CREATE TABLE IF NOT EXISTS agent_decisions (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      root_cause_category TEXT DEFAULT 'unknown',
      recommended_action TEXT NOT NULL,
      rejected_actions TEXT DEFAULT '[]',
      confidence REAL NOT NULL,
      expected_recovery REAL NOT NULL,
      reasoning TEXT NOT NULL,
      policy_requirements TEXT NOT NULL,
      stopping_condition TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      baseline_action TEXT DEFAULT 'retry_payment',
      baseline_reasoning TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      is_fallback INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy_checks (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      check_name TEXT NOT NULL,
      passed INTEGER NOT NULL,
      reason TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_actions (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      approved_at TEXT,
      executed_at TEXT,
      outcome TEXT,
      outcome_amount REAL DEFAULT 0,
      error_message TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      is_demo_replay INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      decision_id TEXT,
      action_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      is_ai_decision INTEGER DEFAULT 0,
      description TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_config (
      id TEXT PRIMARY KEY,
      max_retry_attempts INTEGER DEFAULT 3,
      cooldown_hours INTEGER DEFAULT 24,
      max_contact_per_week INTEGER DEFAULT 3,
      max_transaction_limit REAL DEFAULT 500000,
      confidence_threshold REAL DEFAULT 0.65,
      human_approval_threshold REAL DEFAULT 0.40,
      kill_switch_enabled INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS simulation_batches (
      id TEXT PRIMARY KEY,
      label TEXT,
      event_count INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      stats TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_payment_events_customer ON payment_events(customer_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(status);
    CREATE INDEX IF NOT EXISTS idx_payment_events_split ON payment_events(split);
    CREATE INDEX IF NOT EXISTS idx_recovery_opps_status ON recovery_opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_recovery_opps_customer ON recovery_opportunities(customer_id);
    CREATE INDEX IF NOT EXISTS idx_recovery_opps_split ON recovery_opportunities(split);
    CREATE INDEX IF NOT EXISTS idx_audit_log_opportunity ON audit_log(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  `);

  // Ensure default merchant config
  const existing = db.prepare('SELECT id FROM merchant_config WHERE id = ?').get('default');
  if (!existing) {
    db.prepare(`
      INSERT INTO merchant_config (id, max_retry_attempts, cooldown_hours, max_contact_per_week,
        max_transaction_limit, confidence_threshold, human_approval_threshold, kill_switch_enabled, updated_at)
      VALUES ('default', 3, 24, 3, 500000, 0.65, 0.40, 0, ?)
    `).run(new Date().toISOString());
  }
}
