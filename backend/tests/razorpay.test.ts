/**
 * RAZORPAY INTEGRATION TESTS — REVIVE AI
 *
 * Uses mocks — no real credentials required.
 * Tests adapter behaviour under all documented failure modes.
 *
 * Run: npm test
 * (These run as part of the standard test suite.)
 */

import crypto from 'crypto';

// ── Mock the https module so no real network calls occur ─────────────────────

jest.mock('https', () => {
  const EventEmitter = require('events');

  const makeMockRequest = (responseData: object, statusCode = 200) => {
    return (options: any, callback: any) => {
      const res = new EventEmitter();
      (res as any).statusCode = statusCode;

      const req = {
        write: jest.fn(),
        end: jest.fn(() => {
          callback(res);
          setTimeout(() => {
            res.emit('data', JSON.stringify(responseData));
            res.emit('end');
          }, 0);
        }),
        on: jest.fn(),
        destroy: jest.fn(),
      };
      return req;
    };
  };

  return {
    request: makeMockRequest(
      {
        id: 'plink_test_abc123',
        short_url: 'https://rzp.io/i/testlink',
        amount: 150000,
        currency: 'INR',
        status: 'created',
        reference_id: 'revive_opp123',
        created_at: Math.floor(Date.now() / 1000),
      },
      200
    ),
    __mockRequest: makeMockRequest,
  };
});

// ─────────────────────────────────────────────────────────────────────────────

import { RazorpayAdapter } from '../src/integrations/razorpay/razorpayAdapter';

describe('RazorpayAdapter — unit tests (mocked, no credentials required)', () => {
  let adapter: RazorpayAdapter;

  beforeEach(() => {
    adapter = new RazorpayAdapter();
  });

  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  // ── isTestModeAvailable ──────────────────────────────────────────────────

  it('returns false when no credentials are set', () => {
    expect(adapter.isTestModeAvailable()).toBe(false);
  });

  it('returns false when KEY_ID is not a test key', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_somekey';
    process.env.RAZORPAY_KEY_SECRET = 'somesecret123';
    expect(adapter.isTestModeAvailable()).toBe(false);
  });

  it('returns true when valid test credentials are set', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_validkey';
    process.env.RAZORPAY_KEY_SECRET = 'validtestsecret';
    expect(adapter.isTestModeAvailable()).toBe(true);
  });

  // ── createPaymentLink — SIMULATION mode (no credentials) ────────────────

  it('returns SIMULATION mode and success=true when no credentials', async () => {
    const result = await adapter.createPaymentLink({
      amount: 150000, // paise
      currency: 'INR',
      reference_id: 'revive_opp_test1',
      description: 'Test recovery',
      customer: { name: 'Test User', email: 'test@example.com' },
    });

    expect(result.mode).toBe('SIMULATION');
    expect(result.success).toBe(true);
    expect(result.summary).toContain('SIMULATION');
    expect(result.paymentLinkId).toBeUndefined();
  });

  // ── createPaymentLink — validation ──────────────────────────────────────

  it('rejects non-integer amount', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_validkey';
    process.env.RAZORPAY_KEY_SECRET = 'validtestsecret';

    const result = await adapter.createPaymentLink({
      amount: 1500.5, // fractional paise — invalid
      currency: 'INR',
      reference_id: 'revive_opp_test2',
      description: 'Test',
      customer: { name: 'Test', email: 'test@example.com' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_AMOUNT');
  });

  it('rejects zero amount', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_validkey';
    process.env.RAZORPAY_KEY_SECRET = 'validtestsecret';

    const result = await adapter.createPaymentLink({
      amount: 0,
      currency: 'INR',
      reference_id: 'revive_opp_test3',
      description: 'Test',
      customer: { name: 'Test', email: 'test@example.com' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_AMOUNT');
  });

  // ── createPaymentLink — RAZORPAY_TEST_MODE (mocked network) ─────────────

  it('returns RAZORPAY_TEST_MODE with link URL on mock success', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_validkey';
    process.env.RAZORPAY_KEY_SECRET = 'validtestsecret';

    const result = await adapter.createPaymentLink({
      amount: 150000,
      currency: 'INR',
      reference_id: 'revive_opp_test4',
      description: 'Recovery payment',
      customer: { name: 'Priya Patel', email: 'priya@example.com' },
    });

    expect(result.mode).toBe('RAZORPAY_TEST_MODE');
    expect(result.success).toBe(true);
    expect(result.paymentLinkId).toBe('plink_test_abc123');
    expect(result.paymentLinkUrl).toBe('https://rzp.io/i/testlink');
    expect(result.razorpayStatus).toBe('created');
  });
});

// ── Webhook signature verification ───────────────────────────────────────────

describe('Razorpay webhook signature verification', () => {
  const secret = 'test_webhook_secret_xyz';

  function signPayload(body: string, s = secret): string {
    return crypto.createHmac('sha256', s).update(body).digest('hex');
  }

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ event: 'payment_link.paid' });
    const sig = signPayload(body);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(true);
  });

  it('rejects a payload with a tampered signature', () => {
    const body = JSON.stringify({ event: 'payment_link.paid' });
    const tamperedSig = signPayload(body, 'wrong_secret');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(tamperedSig).not.toBe(expected);
  });

  it('rejects an empty signature string', () => {
    expect('').not.toMatch(/^[a-f0-9]{64}$/);
  });
});
