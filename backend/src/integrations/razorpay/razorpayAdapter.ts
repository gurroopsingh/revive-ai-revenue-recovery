/**
 * RAZORPAY ADAPTER — REVIVE AI
 *
 * Integrates Razorpay Test Mode Payment Links API.
 * This is the ONLY file that contains Razorpay-specific logic.
 *
 * Capability: Create a Payment Link for a failed/abandoned payment.
 * API: POST https://api.razorpay.com/v1/payment_links
 * Auth: Basic Auth (KEY_ID:KEY_SECRET)
 *
 * Execution path:
 *   AI/EV decision
 *   → Policy Engine (deterministic guard)
 *   → THIS ADAPTER (razorpayAdapter.createPaymentLink)
 *   → Razorpay API (test mode)
 *   → Verification (fetch + status check)
 *   → Audit log
 *
 * The adapter NEVER bypasses the Policy Engine.
 * Credentials are NEVER in source. Read from process.env only.
 */

import https from 'https';
import { logger } from '../../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RazorpayPaymentLinkRequest {
  /** Amount in smallest currency unit (paise for INR). Must be integer. */
  amount: number;
  currency: string;
  /** REVIVE internal opportunity ID used as reference_id for traceability */
  reference_id: string;
  description: string;
  customer: {
    name: string;
    email: string;
    contact?: string;
  };
  /** Expiry timestamp (Unix epoch, seconds). Defaults to 24h from now. */
  expire_by?: number;
}

export interface RazorpayPaymentLinkResponse {
  id: string;
  short_url: string;
  amount: number;
  currency: string;
  status: string;        // 'created' | 'paid' | 'cancelled' | 'expired'
  reference_id: string;
  created_at: number;    // Unix epoch
  expire_by?: number;
}

export interface RazorpayAdapterResult {
  mode: 'RAZORPAY_TEST_MODE' | 'SIMULATION';
  success: boolean;
  /** Only present in RAZORPAY_TEST_MODE on success */
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  razorpayStatus?: string;
  /** Human-readable explanation of what was done */
  summary: string;
  error?: string;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class RazorpayAdapter {
  private readonly baseUrl = 'api.razorpay.com';
  private readonly apiVersion = '/v1';

  /**
   * Returns true only when both credentials are present and non-placeholder.
   * Never performs a real API call to check — validation happens at request time.
   */
  isTestModeAvailable(): boolean {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    return !!(
      keyId &&
      keySecret &&
      keyId.startsWith('rzp_test_') &&
      keySecret.length > 10
    );
  }

  /**
   * Creates a Razorpay Payment Link in TEST MODE.
   *
   * Used when action_type = 'send_recovery_message' and Razorpay credentials
   * are configured. The payment link URL is the concrete recovery artefact.
   *
   * Falls back to SIMULATION gracefully on any error.
   */
  async createPaymentLink(
    req: RazorpayPaymentLinkRequest
  ): Promise<RazorpayAdapterResult> {
    if (!this.isTestModeAvailable()) {
      return {
        mode: 'SIMULATION',
        success: true,
        summary:
          'SIMULATION: No Razorpay credentials. Would create a payment link for ₹' +
          (req.amount / 100).toFixed(2),
      };
    }

    // Razorpay requires amount in paise (integer, no decimals)
    if (!Number.isInteger(req.amount) || req.amount <= 0) {
      logger.warn('[Razorpay] Invalid amount — must be positive integer paise');
      return {
        mode: 'RAZORPAY_TEST_MODE',
        success: false,
        summary: 'Invalid amount: must be positive integer paise',
        error: 'INVALID_AMOUNT',
      };
    }

    const payload = JSON.stringify({
      amount: req.amount,
      currency: req.currency || 'INR',
      accept_partial: false,
      reference_id: req.reference_id,
      description: req.description,
      customer: req.customer,
      notify: { sms: false, email: false }, // REVIVE controls outreach
      reminder_enable: false,
      expire_by: req.expire_by ?? Math.floor(Date.now() / 1000) + 86400, // 24h
    });

    try {
      const response = await this.httpsPost<RazorpayPaymentLinkResponse>(
        '/payment_links',
        payload
      );

      logger.info(
        `[Razorpay TEST MODE] Payment link created: ${response.id} | ${response.short_url}`
      );

      return {
        mode: 'RAZORPAY_TEST_MODE',
        success: true,
        paymentLinkId: response.id,
        paymentLinkUrl: response.short_url,
        razorpayStatus: response.status,
        summary: `RAZORPAY TEST MODE: Payment link created. URL: ${response.short_url} | Link ID: ${response.id}`,
      };
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      logger.error(`[Razorpay] Payment link creation failed: ${errMsg}`);

      // Classify error type for audit log
      let errorCode = 'RAZORPAY_API_ERROR';
      if (errMsg.includes('401') || errMsg.includes('403')) {
        errorCode = 'INVALID_CREDENTIALS';
      } else if (errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')) {
        errorCode = 'API_TIMEOUT';
      } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED')) {
        errorCode = 'API_UNAVAILABLE';
      } else if (errMsg.includes('duplicate') || errMsg.includes('already exists')) {
        errorCode = 'DUPLICATE_REQUEST';
      }

      // All errors fall back to simulation — never crash the recovery pipeline
      return {
        mode: 'RAZORPAY_TEST_MODE',
        success: false,
        summary: `Razorpay API call failed (${errorCode}). Falling back to simulation.`,
        error: errorCode,
      };
    }
  }

  /**
   * Fetches the status of an existing payment link.
   * Used for post-execution verification step.
   */
  async getPaymentLinkStatus(
    linkId: string
  ): Promise<{ status: string; paid: boolean } | null> {
    if (!this.isTestModeAvailable()) return null;

    try {
      const response = await this.httpsGet<RazorpayPaymentLinkResponse>(
        `/payment_links/${encodeURIComponent(linkId)}`
      );
      return {
        status: response.status,
        paid: response.status === 'paid',
      };
    } catch (err: any) {
      logger.warn(`[Razorpay] Could not fetch payment link status: ${err?.message}`);
      return null;
    }
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private authHeader(): string {
    const keyId = process.env.RAZORPAY_KEY_ID!;
    const keySecret = process.env.RAZORPAY_KEY_SECRET!;
    return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  }

  private httpsPost<T>(path: string, body: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: `${this.apiVersion}${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: this.authHeader(),
        },
        timeout: 10000, // 10s hard timeout
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON from Razorpay: ${data}`));
            }
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout: Razorpay API did not respond within 10s'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private httpsGet<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: `${this.apiVersion}${path}`,
        method: 'GET',
        headers: { Authorization: this.authHeader() },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON from Razorpay: ${data}`));
            }
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }
}

export const razorpayAdapter = new RazorpayAdapter();
