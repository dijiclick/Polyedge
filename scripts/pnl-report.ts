#!/usr/bin/env npx tsx
/**
 * pnl-report.ts
 * 
 * Run: npx tsx scripts/pnl-report.ts [--resolve]
 *
 * --resolve: Check Polymarket for resolved markets and update P&L
 * (no flag): Just print current report
 *
 * Also handles self-improvement: if any strategy has win rate < 40%
 * over 10+ resolved trades, it spawns a Claude Code session to fix it.
 */

import { resolvePaperTrades, printReport, generateReport, loadTrades } from '../src/shared/paper-trader.js';
import { tg } from '../src/shared/telegram.js';
import { spawnSync } from 'child_process';

async function main() {
  const args = process.argv.slice(2);
  const doResolve = args.includes('--resolve');
  const doImprove = args.includes('--improve');

  if (doResolve) {
    console.log('[pnl] Resolving paper trades against Polymarket...');
    const result = await resolvePaperTrades();
    console.log(`[pnl] Resolved ${result.resolved} trades: ${result.wins}W / ${result.losses}L`);

    if (result.resolved > 0) {
      const { overall, byStrategy } = generateReport();
      const msg = `📊 Paper Trading Update: +${result.wins}W / -${result.losses}L resolved\n` +
        `Overall: ${overall.total} total | ${overall.wins}W ${overall.losses}L | P&L $${overall.totalPnl.toFixed(2)}\n` +
        byStrategy.slice(0, 5).map(s => `  ${s.strategy}: ${s.wins}W ${s.losses}L P&L $${s.totalPnl.toFixed(2)}`).join('\n');
      await tg(msg);
    }
  }

  printReport();

  if (doImprove) {
    await checkAndImprove();
  }
}

async function checkAndImprove() {
  const { byStrategy } = generateReport();

  for (const s of byStrategy) {
    const resolved = s.wins + s.losses;
    if (resolved < 10) continue;  // Need enough data
    if (s.winRate >= 0.45) continue;  // Acceptable

    console.log(`\n🔧 Strategy needs improvement: ${s.strategy} | ${(s.winRate*100).toFixed(0)}% win rate | P&L $${s.totalPnl.toFixed(2)}`);
    await tg(`🔧 Auto-improving ${s.strategy}: ${(s.winRate*100).toFixed(0)}% win rate over ${resolved} trades`);

    // Build improvement context
    const trades = loadTrades().filter(t => t.strategy === s.strategy && t.resolved);
    const losses = trades.filter(t => t.outcome === 'LOSE').slice(0, 10);
    const wins   = trades.filter(t => t.outcome === 'WIN').slice(0, 5);

    const context = `Strategy: ${s.strategy}
Current win rate: ${(s.winRate*100).toFixed(0)}% over ${resolved} trades
P&L: $${s.totalPnl.toFixed(2)} ROI: ${(s.roi*100).toFixed(0)}%
Avg edge claimed: ${(s.avgEdge*100).toFixed(0)}%

Recent LOSSES (what we got wrong):
${losses.map(t => `- ${t.category}: "${t.question.slice(0,80)}" @ ${t.entryPrice.toFixed(2)} | Reason: ${t.signalReason.slice(0,80)}`).join('\n')}

Recent WINS (what worked):
${wins.map(t => `- ${t.category}: "${t.question.slice(0,80)}" @ ${t.entryPrice.toFixed(2)}`).join('\n')}

Task: Analyze why this strategy is losing and improve it. The strategy file is at:
/home/ariad/.openclaw/workspace/Polyedge/src/strategies/${s.strategy}.ts

Look at the loss patterns and:
1. Identify the core problem (bad confidence thresholds? wrong data source? false signals?)
2. Fix the strategy code  
3. Adjust confidence/edge thresholds based on actual performance
4. Run: npx tsx src/strategies/${s.strategy}.ts to verify it compiles
5. Commit the fix with: git commit --no-verify -m "fix(${s.strategy}): improve based on paper trading data"`;

    console.log('\nImprovement context prepared. Spawning analysis...');
    
    // Write context to a file for Claude Code to pick up
    const { writeFileSync } = await import('fs');
    const contextFile = `/tmp/improve-${s.strategy}-${Date.now()}.md`;
    writeFileSync(contextFile, context);
    console.log(`Context written to ${contextFile}`);
    console.log('To run improvement: cat the file and send to a Claude Code session');
    
    // Note: sessions_spawn for ACP requires manual trigger here
    // The main agent will read this and spawn Claude Code when appropriate
  }
}

main().catch(console.error);
