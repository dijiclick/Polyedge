#!/usr/bin/env npx tsx
/**
 * pnl-report.ts
 * 
 * Run: npx tsx scripts/pnl-report.ts [--resolve] [--improve]
 *
 * --resolve : Check Polymarket for resolved markets, update P&L
 * --improve : For bad strategies, spawn improvement or disable
 * (no flag)  : Print current report
 *
 * Called by cron: hourly with --resolve, daily 8am with --resolve --improve
 */

import { resolvePaperTrades, printReport, generateReport, loadTrades } from '../src/shared/paper-trader.js';
import { tg } from '../src/shared/telegram.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const RUNNER_FILE  = path.join(import.meta.dirname ?? '.', '../src/runner.ts');
const DATA_DIR     = '/home/ariad/.openclaw/workspace/Polyedge/data';
const IMPROVE_LOG  = `${DATA_DIR}/improvement-history.json`;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const resolve = args.includes('--resolve');
  const improve = args.includes('--improve');

  if (resolve) {
    console.log('[pnl] Resolving paper trades...');
    const result = await resolvePaperTrades();
    console.log(`[pnl] +${result.resolved} resolved: ${result.wins}W / ${result.losses}L`);

    if (result.resolved > 0) {
      const { overall, byStrategy } = generateReport();
      const lines = byStrategy
        .filter(s => s.wins + s.losses > 0)
        .map(s => `  ${s.strategy.padEnd(18)} ${s.wins}W/${s.losses}L  ${(s.winRate*100).toFixed(0)}%  P&L $${s.totalPnl.toFixed(2)}`);

      const msg = `📊 Polyedge Daily Update\n` +
        `${overall.total} predictions | ${overall.wins}W ${overall.losses}L | ` +
        `Win rate ${(overall.winRate*100).toFixed(0)}% | P&L $${overall.totalPnl.toFixed(2)}\n\n` +
        lines.join('\n');
      await tg(msg);
    }
  }

  printReport();

  if (improve) {
    await dailyImprovement();
  }
}

// ─── Daily improvement loop ───────────────────────────────────────────────────

interface ImprovementRecord {
  strategy:   string;
  attempts:   number;
  lastAttempt: string;
  disabled:   boolean;
}

function loadImprovements(): ImprovementRecord[] {
  if (!existsSync(IMPROVE_LOG)) return [];
  try { return JSON.parse(readFileSync(IMPROVE_LOG, 'utf8')); } catch { return []; }
}
function saveImprovements(r: ImprovementRecord[]) {
  writeFileSync(IMPROVE_LOG, JSON.stringify(r, null, 2));
}

async function dailyImprovement() {
  const { byStrategy } = generateReport();
  const improvements   = loadImprovements();

  for (const s of byStrategy) {
    const resolved = s.wins + s.losses;
    if (resolved < 5) continue;  // not enough data yet

    const rec = improvements.find(r => r.strategy === s.strategy);

    // ── Already disabled → skip ──────────────────────────────────────────────
    if (rec?.disabled) {
      console.log(`[improve] ${s.strategy} is DISABLED (too many failed attempts)`);
      continue;
    }

    // ── Strategy is profitable → skip, no action needed ─────────────────────
    if (s.winRate >= 0.50 && s.totalPnl >= 0) {
      console.log(`[improve] ✅ ${s.strategy}: ${(s.winRate*100).toFixed(0)}% win rate — profitable, no action`);
      continue;
    }

    // ── Bad strategy → needs improvement ─────────────────────────────────────
    const attempts = rec?.attempts ?? 0;
    const isBad    = s.winRate < 0.40 && resolved >= 10;
    const isOkay   = s.winRate >= 0.40 || resolved < 10;  // borderline — watch

    if (isOkay && !isBad) {
      console.log(`[improve] ⏳ ${s.strategy}: ${(s.winRate*100).toFixed(0)}% win rate, ${resolved} trades — watching`);
      continue;
    }

    // ── 3 failed improvement attempts → DISABLE strategy ─────────────────────
    if (attempts >= 3) {
      console.log(`[improve] ❌ Disabling ${s.strategy} after ${attempts} failed improvement attempts`);
      await disableStrategy(s.strategy);
      const entry = improvements.find(r => r.strategy === s.strategy);
      if (entry) entry.disabled = true;
      else improvements.push({ strategy: s.strategy, attempts, lastAttempt: new Date().toISOString(), disabled: true });
      saveImprovements(improvements);
      await tg(`🚫 Strategy DISABLED: ${s.strategy} (${(s.winRate*100).toFixed(0)}% win rate after ${resolved} trades, ${attempts} fix attempts failed)`);
      continue;
    }

    // ── Trigger improvement ───────────────────────────────────────────────────
    console.log(`\n[improve] 🔧 ${s.strategy}: ${(s.winRate*100).toFixed(0)}% win rate — triggering improvement (attempt ${attempts + 1}/3)`);
    await triggerImprovement(s);

    // Update record
    const existing = improvements.find(r => r.strategy === s.strategy);
    if (existing) { existing.attempts++; existing.lastAttempt = new Date().toISOString(); }
    else improvements.push({ strategy: s.strategy, attempts: 1, lastAttempt: new Date().toISOString(), disabled: false });
    saveImprovements(improvements);
  }
}

// ─── Trigger improvement for a bad strategy ───────────────────────────────────

async function triggerImprovement(s: any) {
  const trades  = loadTrades().filter(t => t.strategy === s.strategy && t.resolved);
  const losses  = trades.filter(t => t.outcome === 'LOSE').slice(0, 15);
  const wins    = trades.filter(t => t.outcome === 'WIN').slice(0, 8);
  const pending = loadTrades().filter(t => t.strategy === s.strategy && !t.resolved).slice(0, 5);

  const brief = `# Strategy Improvement Brief: ${s.strategy}

## Performance
- Win rate: ${(s.winRate*100).toFixed(0)}% (target: 50%+)
- P&L: $${s.totalPnl.toFixed(2)} over ${s.wins + s.losses} resolved trades
- ROI: ${(s.roi*100).toFixed(0)}%
- Avg claimed edge: ${(s.avgEdge*100).toFixed(0)}%
- Avg confidence: ${(s.avgConf*100).toFixed(0)}%

## Problem
Win rate ${(s.winRate*100).toFixed(0)}% means the strategy is LOSING money. The claimed edge of ${(s.avgEdge*100).toFixed(0)}% is NOT materializing.

## What We Got Wrong (Recent Losses)
${losses.map(t => `- [${t.category}] "${t.question.slice(0,90)}"
  Entry: ${t.entryPrice.toFixed(3)} | Conf: ${(t.confidence*100).toFixed(0)}% | Edge: ${(t.edge*100).toFixed(0)}%
  Reason: ${t.signalReason.slice(0,100)}`).join('\n')}

## What Worked (Recent Wins)
${wins.map(t => `- [${t.category}] "${t.question.slice(0,90)}"
  Entry: ${t.entryPrice.toFixed(3)} | Edge: ${(t.edge*100).toFixed(0)}%`).join('\n')}

## Current Pending Signals
${pending.map(t => `- [${t.category}] "${t.question.slice(0,90)}" @ ${t.entryPrice.toFixed(3)}`).join('\n') || 'None'}

## Task
File: /home/ariad/.openclaw/workspace/Polyedge/src/strategies/${s.strategy}.ts

1. Read the strategy file carefully
2. Identify WHY it's losing (bad signal detection? overconfident? wrong data source? wrong market matching?)
3. Fix specifically: raise confidence thresholds, improve market matching, fix data sources
4. After changes: npx tsx src/strategies/${s.strategy}.ts (dry run check)
5. git add -A && git commit --no-verify -m "fix(${s.strategy}): improve based on paper trading — was ${(s.winRate*100).toFixed(0)}% win rate"
6. git push --no-verify`;

  const briefFile = `${DATA_DIR}/improve-${s.strategy}-${Date.now()}.md`;
  writeFileSync(briefFile, brief);

  console.log(`[improve] Brief written to ${briefFile}`);
  await tg(`🔧 Auto-improving ${s.strategy}: ${(s.winRate*100).toFixed(0)}% win rate\nBrief: ${briefFile}\nSending to Claude Code...`);

  // Spawn Claude Code sub-agent to fix this
  // (main agent will receive this and spawn via sessions_spawn)
  const taskMsg = `Read this improvement brief and fix the strategy:\n\n${brief.slice(0, 3000)}`;
  writeFileSync(`${DATA_DIR}/pending-improvement-${s.strategy}.txt`, taskMsg);
  console.log(`[improve] Task queued for Claude Code: ${DATA_DIR}/pending-improvement-${s.strategy}.txt`);
}

// ─── Disable a strategy in runner.ts ──────────────────────────────────────────

async function disableStrategy(strategy: string) {
  if (!existsSync(RUNNER_FILE)) {
    console.log(`[improve] runner.ts not found at ${RUNNER_FILE}`);
    return;
  }

  let src = readFileSync(RUNNER_FILE, 'utf8');
  // Comment out the strategy block in runner.ts
  const pattern = new RegExp(
    `(  if \\(STRATEGY === 'both' \\|\\| STRATEGY === '${strategy}'\\)[\\s\\S]*?runners\\.push\\([^)]+\\);\\s*\\})`,
    'g'
  );
  const updated = src.replace(pattern, (m) => `  /* DISABLED(low-perf): ${strategy}\n${m}\n  */`);

  if (updated !== src) {
    writeFileSync(RUNNER_FILE, updated);
    console.log(`[improve] ✅ ${strategy} disabled in runner.ts`);
  } else {
    console.log(`[improve] Could not auto-disable ${strategy} in runner.ts (pattern not found)`);
  }
}

main().catch(console.error);
