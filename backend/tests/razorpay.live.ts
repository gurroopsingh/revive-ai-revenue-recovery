/**
 * RAZORPAY LIVE INTEGRATION TEST — REVIVE AI
 *
 * Makes a REAL call to Razorpay TEST MODE API.
 * Requires: RAZORPAY_KEY_ID (must start with rzp_test_)
 *           RAZORPAY_KEY_SECRET
 *
 * Run: npm run test:razorpay
 *
 * NEVER run with live/production credentials.
 * No real money moves — Razorpay test mode only.
 */

import dotenv from 'dotenv';
dotenv.config();

import { RazorpayAdapter } from '../src/integrations/razorpay/razorpayAdapter';

const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

function pass(msg: string) { console.log(`${GREEN}  ✓ PASS${RESET}  ${msg}`); }
function fail(msg: string) { console.log(`${RED}  ✗ FAIL${RESET}  ${msg}`); }
function info(msg: string) { console.log(`${CYAN}  ℹ${RESET}       ${msg}`); }

async function main() {
  console.log(`\n${BOLD}REVIVE AI — Razorpay Test Mode Live Integration Test${RESET}`);
  console.log('─'.repeat(56));
  console.log('Mode:    RAZORPAY TEST MODE (no real money)');
  console.log('API:     POST https://api.razorpay.com/v1/payment_links');
  console.log('─'.repeat(56));

  // ── Guard: refuse to run without credentials ──────────────────────────────
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.log(`\n${RED}${BOLD}MISSING CREDENTIALS${RESET}`);
    console.log('Set these environment variables to run this test:\n');
    console.log('  RAZORPAY_KEY_ID=rzp_test_...');
    console.log('  RAZORPAY_KEY_SECRET=...\n');
    console.log('Get test keys from: https://dashboard.razorpay.com/app/keys');
    process.exit(1);
  }

  if (!keyId.startsWith('rzp_test_')) {
    console.log(`\n${RED}${BOLD}SAFETY GUARD: KEY_ID must start with rzp_test_${RESET}`);
    console.log('Do NOT run this test with live/production credentials.');
    process.exit(1);
  }

  const adapter = new RazorpayAdapter();
  let allPassed = true;

  // ── Test 1: isTestModeAvailable ───────────────────────────────────────────
  console.log('\n[1/3] Credential detection');
  if (adapter.isTestModeAvailable()) {
    pass('isTestModeAvailable() returns true with valid test credentials');
  } else {
    fail('isTestModeAvailable() returned false — check credentials');
    allPassed = false;
  }

  // ── Test 2: Create a Payment Link ─────────────────────────────────────────
  console.log('\n[2/3] Create Razorpay Test Mode Payment Link');
  const opportunityId = 'live-test-' + Date.now();
  const testAmountPaise = 50000; // ₹500 in paise

  info(`Sending POST /v1/payment_links — amount: ₹${testAmountPaise / 100}`);

  const result = await adapter.createPaymentLink({
    amount: testAmountPaise,
    currency: 'INR',
    reference_id: `revive_${opportunityId.slice(0, 16)}`,
    description: 'REVIVE AI — live integration test payment link',
    customer: {
      name: 'REVIVE Test Customer',
      email: 'revive-test@example.com',
    },
  });

  if (result.mode !== 'RAZORPAY_TEST_MODE') {
    fail(`Expected RAZORPAY_TEST_MODE, got: ${result.mode}`);
    allPassed = false;
  } else if (!result.success) {
    fail(`Payment link creation failed: ${result.error}`);
    fail(`Summary: ${result.summary}`);
    allPassed = false;
  } else {
    pass('Payment link created successfully in Razorpay TEST MODE');
    info(`Link ID:  ${result.paymentLinkId}`);
    info(`Link URL: ${result.paymentLinkUrl}`);
    info(`Status:   ${result.razorpayStatus}`);
  }

  // ── Test 3: Fetch link status ─────────────────────────────────────────────
  if (result.success && result.paymentLinkId) {
    console.log('\n[3/3] Fetch Payment Link Status');
    const status = await adapter.getPaymentLinkStatus(result.paymentLinkId);
    if (status) {
      pass(`Fetched status: ${status.status} | paid: ${status.paid}`);
    } else {
      fail('Could not fetch payment link status');
      allPassed = false;
    }
  } else {
    console.log('\n[3/3] Skipping status fetch (link creation failed)');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(56));
  if (allPassed) {
    console.log(`${GREEN}${BOLD}ALL TESTS PASSED${RESET} — Razorpay test mode integration verified`);
    console.log('\nWhat was verified against Razorpay test mode:');
    console.log('  • POST /v1/payment_links — payment link creation');
    console.log('  • GET  /v1/payment_links/:id — status fetch');
    console.log('  • Basic Auth (test credentials)');
    console.log('\nWhat remains simulated:');
    console.log('  • Customer payment of the link (use Razorpay test checkout)');
    console.log('  • Webhook payment_link.paid event');
    console.log('  • All actions other than send_recovery_message\n');
  } else {
    console.log(`${RED}${BOLD}SOME TESTS FAILED${RESET} — check output above\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
