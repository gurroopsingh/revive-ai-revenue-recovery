import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { initDatabase, getDb } from './db/database';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { apiRouter } from './routes';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/ping', (req, res) => res.send('pong'));

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api', apiRouter);

// Health check
app.get('/health', (_req, res) => {
  try {
    const db = getDb();
    const events = (db.prepare('SELECT COUNT(*) as n FROM payment_events').get() as any).n;
    const opps = (db.prepare('SELECT COUNT(*) as n FROM recovery_opportunities').get() as any).n;
    const decisions = (db.prepare('SELECT COUNT(*) as n FROM agent_decisions').get() as any).n;
    const config = db.prepare('SELECT kill_switch_enabled FROM merchant_config WHERE id = ?').get('default') as any;
    const evalPath = path.resolve(process.cwd(), '../evaluation/results.json');
    const lastEval = fs.existsSync(evalPath)
      ? JSON.parse(fs.readFileSync(evalPath, 'utf8')).generated_at
      : null;
    res.json({
      status: 'ok',
      service: 'REVIVE AI Backend',
      timestamp: new Date().toISOString(),
      database: { status: 'connected', events, opportunities: opps, decisions },
      agent: { gemini_model: 'gemini-1.5-flash', api_key_set: !!process.env.GEMINI_API_KEY },
      simulation_mode: !process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_key_here',
      razorpay_mode: !!(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET),
      dataset: { seed: process.env.SEED || '42', events },
      kill_switch: config?.kill_switch_enabled === 1,
      last_evaluation: lastEval,
    });
  } catch {
    res.status(500).json({ status: 'error', message: 'Database not ready' });
  }
});

// Error handler
app.use(errorHandler);

async function main() {
  try {
    initDatabase();
    logger.info('Database initialized');

    app.listen(PORT, () => {
      logger.info(`REVIVE AI Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

main();

// Keep the process alive even if a Promise rejects unexpectedly (e.g. Gemini timeout race).
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (process kept alive)', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (process kept alive)', { message: err.message });
});
