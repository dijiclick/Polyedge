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

const ARMED    = process.env.ARMED === 'true';
const STRATEGY = process.env.STRATEGY || 'both';  // 'oracle' | 'edge' | 'both'

async function main() {
  const mode = ARMED ? '🔴 LIVE' : '🟡 DRY-RUN';
  const strategies = STRATEGY === 'oracle' ? 'Oracle Arb only'
    : STRATEGY === 'edge' ? 'Edge AI only'
    : 'Oracle Arb + Edge AI';

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

  // Run all strategies concurrently
  await Promise.all(runners.map(fn => fn().catch(e => {
    console.error('[runner] strategy error:', e);
    tg(`❌ Strategy error: ${e.message}`);
  })));
}

main().catch(e => {
  console.error('[runner] fatal:', e);
  process.exit(1);
});
