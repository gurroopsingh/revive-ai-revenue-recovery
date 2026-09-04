/**
 * RAZORPAY WEBHOOK ROUTE — REVIVE AI
 *
 * Endpoint: POST /api/razorpay/webhook
 *
 * Verifies Razorpay webhook signature using HMAC-SHA256.
 * On a `payment_link.paid` event, marks the corresponding
 * recovery opportunity as `recovered` and logs to audit trail.
 *
 * Safety: Signature verification is mandatory.
 * Any request without a valid signature is rejected with 400.
 *
 * Reference: https://razorpay.com/docs/webhooks/validate-test/
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/database';
import { auditService } from '../services/auditService';
import { logger } from '../utils/logger';

export const razorpayWebhookRouter = Router();

// Razorpay sends raw body for signature validation — must use express.raw()
razorpayWebhookRouter.post(
  '/webhook',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req: Request, res: Response): any => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      // Credentials not configured — accept but do nothing (simulation mode)
      logger.warn('[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET not set — ignoring event');
      return res.status(200).json({ received: true, mode: 'SIMULATION' });
    }

    // ── SIGNATURE VERIFICATION ──────────────────────────────────────────────
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    if (!signature) {
      logger.warn('[Razorpay Webhook] Missing X-Razorpay-Signature header');
      return res.status(400).json({ error: 'Missing signature header' });
    }

    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      logger.warn('[Razorpay Webhook] Raw body not available — ensure express.raw() is applied');
      return res.status(400).json({ error: 'Raw body unavailable' });
    }

    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSig, 'hex')
      )
    ) {
      logger.warn('[Razorpay Webhook] Invalid signature — rejecting event');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── PROCESS EVENT ───────────────────────────────────────────────────────
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const event = payload?.event as string | undefined;
    logger.info(`[Razorpay Webhook] Received event: ${event}`);

    if (event === 'payment_link.paid') {
      handlePaymentLinkPaid(payload).catch((err) =>
        logger.error('[Razorpay Webhook] Handler error', err)
      );
    }

    // Always acknowledge promptly — async processing above
    res.status(200).json({ received: true, mode: 'RAZORPAY_TEST_MODE', event });
  }
);

// ── Async handler ──────────────────────────────────────────────────────────────

async function handlePaymentLinkPaid(payload: any): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // Razorpay reference_id = `revive_${opportunityId.slice(0,16)}`
  const referenceId: string = payload?.payload?.payment_link?.entity?.reference_id ?? '';
  if (!referenceId.startsWith('revive_')) {
    logger.warn('[Razorpay Webhook] payment_link.paid has no matching REVIVE reference_id');
    return;
  }

  const opportunityIdPrefix = referenceId.slice('revive_'.length); // first 16 chars of ID

  const opp = db.prepare(
    `SELECT id, status FROM recovery_opportunities WHERE id LIKE ? LIMIT 1`
  ).get(`${opportunityIdPrefix}%`) as { id: string, status: string } | undefined;

  if (!opp) {
    logger.warn(`[Razorpay Webhook] No opportunity found for reference ${referenceId}`);
    return;
  }

  if (opp.status === 'recovered') {
    logger.info(`[Razorpay Webhook] Opportunity ${opp.id.slice(0, 8)} is already recovered. Ignoring duplicate webhook.`);
    return;
  }

  const amountPaid: number = payload?.payload?.payment?.entity?.amount ?? 0; // paise
  const amountInr = amountPaid / 100;

  db.prepare(
    `UPDATE recovery_opportunities SET status = 'recovered', updated_at = ? WHERE id = ?`
  ).run(now, opp.id);

  await auditService.log({
    opportunity_id: opp.id,
    event_type: 'action_success',
    description: `[RAZORPAY TEST MODE] ✓ payment_link.paid webhook received — ₹${amountInr.toFixed(2)} recovered`,
    data: {
      is_ai_decision: false,
      execution_mode: 'RAZORPAY_TEST_MODE',
      source: 'webhook',
      reference_id: referenceId,
      amount_inr: amountInr,
    },
  });

  logger.info(
    `[Razorpay Webhook] Opportunity ${opp.id.slice(0, 8)} marked recovered — ₹${amountInr.toFixed(2)}`
  );
}
