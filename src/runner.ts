/**
 * Polymarket Trading Runner
 * 
 * Runs both strategies simultaneously:
 *   1. Oracle Lag Arb   — scan expired/near-expiry markets, buy YES at 88-98¢
 *   2. Edge AI Predictor — scan 0-3h markets, use AI to predict outcome
 *
 * Usage:
 *   npx tsx src/trading/runner.ts              # dry-run both
 *   ARMED=true npx tsx src/trading/runner.ts   # live trading
 *   STRATEGY=oracle npx tsx src/trading/runner.ts   # only oracle arb
 *   STRATEGY=edge npx tsx src/trading/runner.ts     # only edge AI
 */

import { tg } from './shared/telegram.js';
import { startSweeper } from './shared/sweeper.js';

const ARMED    = process.env.ARMED === 'true';
const STRATEGY = process.env.STRATEGY || 'both';  // 'oracle' | 'edge' | 'both'

async function main() {
  // Inject --monitor so strategies run in continuous loop mode
  if (!process.argv.includes('--monitor')) process.argv.push('--monitor');

  const mode = ARMED ? '🔴 LIVE' : '🟡 DRY-RUN';
  const strategies = STRATEGY === 'oracle' ? 'Oracle Arb only'
    : STRATEGY === 'edge' ? 'Edge AI only'
    : 'Oracle Arb + Edge AI + Crypto Oracle + Live Score';

  console.log(`🚀 Polymarket Trading Runner`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Strategies: ${strategies}`);
  console.log(`   Risk level: ${process.env.RISK_LEVEL || 'MEDIUM'}`);
  console.log();

  await tg(
    `🤖 <b>Trading Runner Started</b>\n` +
    `Mode: ${mode}\n` +
    `Strategies: ${strategies}\n` +
    `Risk: ${process.env.RISK_LEVEL || 'MEDIUM'}`
  );

  const runners: Array<() => Promise<void>> = [];

  if (STRATEGY === 'oracle' || STRATEGY === 'both') {
    const { runOracleArb } = await import('./strategies/oracle-arb.js');
    runners.push(runOracleArb);
  }

  if (STRATEGY === 'edge' || STRATEGY === 'both') {
    const { runEdgeAI } = await import('./strategies/edge-ai.js');
    runners.push(runEdgeAI);
  }

  if (STRATEGY === 'both' || STRATEGY === 'crypto') {
    const { runCryptoOracle } = await import('./strategies/crypto-oracle.js');
    runners.push(runCryptoOracle);
  }

  if (STRATEGY === 'both' || STRATEGY === 'live') {
    const { runLiveScore } = await import('./strategies/live-score.js');
    runners.push(runLiveScore);
  }

  if (STRATEGY === 'both' || STRATEGY === 'odds') {
    const { runOddsArb } = await import('./strategies/odds-arb.js');
    runners.push(runOddsArb);
  }

  // Start position sweeper (auto-closes resolved positions)
  startSweeper();

  // Run all strategies concurrently (they use setInterval + keep-alive internally)
  await Promise.all([
    ...runners.map(fn => fn().catch(e => {
      console.error('[runner] strategy error:', e);
      tg(`❌ Strategy error: ${e.message}`);
    })),
    new Promise(() => {}), // belt-and-suspenders: never resolves
  ]);
}

main().catch(e => {
  console.error('[runner] fatal:', e);
  const msg = String(e?.message ?? e).toLowerCase();
  const isRateLimit = msg.includes('429') || msg.includes('rate limit') ||
                      msg.includes('too many') || msg.includes('quota');
  if (isRateLimit) {
    console.error('[runner] Rate limit hit — watchdog will retry in 15 min');
    // Write lock so watchdog waits 15 min
    const { writeFileSync } = require('fs');
    writeFileSync('/tmp/polyedge_rl_recovery.lock', String(Math.floor(Date.now()/1000)));
  }
  process.exit(isRateLimit ? 2 : 1);  // exit code 2 = rate limit
});
