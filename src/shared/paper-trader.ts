/**
 * Paper Trading Tracker
 *
 * Logs every signal from every strategy WITHOUT placing real bets.
 * When markets resolve, calculates theoretical P&L per strategy/category.
 *
 * Usage:
 *   import { logPaperTrade, resolvePaperTrades, printReport } from './paper-trader.js';
 *
 * Every strategy calls logPaperTrade() instead of placeBuy().
 * Cron runs resolvePaperTrades() daily to check outcomes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const DATA_DIR  = path.join(process.env.HOME || '/tmp', '.openclaw/workspace/Polyedge/data');
const TRADES_FILE = path.join(DATA_DIR, 'paper-trades.json');
const BET_SIZE  = 1.0;  // simulate $1 per trade

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaperTrade {
  id:           string;
  strategy:     string;
  category:     string;
  question:     string;
  conditionId:  string;
  side:         'YES' | 'NO';
  entryPrice:   number;
  confidence:   number;
  edge:         number;
  betSize:      number;
  timestamp:    string;
  signalReason: string;
  // Filled when resolved:
  resolved?:    boolean;
  outcome?:     'WIN' | 'LOSE' | 'PUSH';
  exitPrice?:   number;
  pnl?:         number;
  resolvedAt?:  string;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadTrades(): PaperTrade[] {
  ensureDir();
  if (!existsSync(TRADES_FILE)) return [];
  try { return JSON.parse(readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

function saveTrades(trades: PaperTrade[]): void {
  ensureDir();
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// ─── Log a paper trade ────────────────────────────────────────────────────────

export function logPaperTrade(params: {
  strategy:     string;
  category:     string;
  question:     string;
  conditionId:  string;
  side:         'YES' | 'NO';
  entryPrice:   number;
  confidence:   number;
  edge:         number;
  signalReason: string;
}): PaperTrade {
  const trade: PaperTrade = {
    id:           `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    betSize:      BET_SIZE,
    timestamp:    new Date().toISOString(),
    resolved:     false,
    ...params,
  };

  const trades = loadTrades();
  // Deduplicate: skip if same conditionId + strategy already pending
  const existing = trades.find(t => t.conditionId === params.conditionId && t.strategy === params.strategy && !t.resolved);
  if (existing) {
    console.log(`[paper] Duplicate signal skipped: ${params.question.slice(0, 60)}`);
    return existing;
  }

  trades.push(trade);
  saveTrades(trades);

  console.log(`[paper] 📝 Logged: [${params.strategy}] ${params.side} @ ${params.entryPrice.toFixed(3)} | edge ${(params.edge*100).toFixed(1)}% | ${params.question.slice(0,70)}`);
  return trade;
}

// ─── Resolve trades: check Polymarket CLOB for market outcomes ───────────────

function winCurl(url: string): any {
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', ['-s', '--max-time', '10', url], {
    encoding: 'utf8', timeout: 13000, maxBuffer: 2 * 1024 * 1024
  });
  if (!r.stdout || r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export async function resolvePaperTrades(): Promise<{ resolved: number; wins: number; losses: number }> {
  const trades = loadTrades();
  const pending = trades.filter(t => !t.resolved);
  if (pending.length === 0) return { resolved: 0, wins: 0, losses: 0 };

  let resolved = 0, wins = 0, losses = 0;

  for (const trade of pending) {
    // Fetch market from Gamma
    const m = winCurl(`https://gamma-api.polymarket.com/markets/${trade.conditionId}`);
    if (!m) continue;

    const isClosed = m.closed === true || m.active === false;
    if (!isClosed) continue;  // still open

    // Get resolution: outcomePrices → settled to 0 or 1
    const prices = JSON.parse(m.outcomePrices ?? '[]');
    const yesSettled = parseFloat(prices[0] ?? '0.5');

    const won = trade.side === 'YES' ? yesSettled >= 0.99 : yesSettled <= 0.01;
    const push = yesSettled > 0.01 && yesSettled < 0.99;

    trade.resolved   = true;
    trade.resolvedAt = new Date().toISOString();
    trade.exitPrice  = trade.side === 'YES' ? yesSettled : 1 - yesSettled;

    if (push) {
      trade.outcome = 'PUSH';
      trade.pnl = 0;
    } else if (won) {
      trade.outcome = 'WIN';
      // Profit = (1 - entryPrice) * betSize / entryPrice * entryPrice = (1 - entryPrice) * betSize
      trade.pnl = (1 - trade.entryPrice) * trade.betSize;
      wins++;
    } else {
      trade.outcome = 'LOSE';
      trade.pnl = -trade.betSize;
      losses++;
    }

    resolved++;
    console.log(`[paper] ✅ Resolved: ${trade.outcome} | pnl=${trade.pnl?.toFixed(2)} | ${trade.question.slice(0,60)}`);
  }

  if (resolved > 0) saveTrades(trades);
  return { resolved, wins, losses };
}

// ─── P&L Report ───────────────────────────────────────────────────────────────

export interface StrategyStats {
  strategy:  string;
  total:     number;
  pending:   number;
  wins:      number;
  losses:    number;
  pushes:    number;
  winRate:   number;
  totalPnl:  number;
  roi:       number;      // ROI on capital deployed
  avgEdge:   number;
  avgConf:   number;
}

export function generateReport(): { byStrategy: StrategyStats[]; byCategory: StrategyStats[]; overall: StrategyStats } {
  const trades = loadTrades();

  function calcStats(name: string, group: PaperTrade[]): StrategyStats {
    const resolved = group.filter(t => t.resolved && t.outcome !== 'PUSH');
    const wins    = resolved.filter(t => t.outcome === 'WIN').length;
    const losses  = resolved.filter(t => t.outcome === 'LOSE').length;
    const pushes  = group.filter(t => t.outcome === 'PUSH').length;
    const totalPnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const capital  = group.length * BET_SIZE;
    const avgEdge  = group.length ? group.reduce((s,t) => s + t.edge, 0) / group.length : 0;
    const avgConf  = group.length ? group.reduce((s,t) => s + t.confidence, 0) / group.length : 0;

    return {
      strategy: name,
      total:    group.length,
      pending:  group.filter(t => !t.resolved).length,
      wins, losses, pushes,
      winRate:  resolved.length ? wins / resolved.length : 0,
      totalPnl,
      roi:      capital ? totalPnl / capital : 0,
      avgEdge,
      avgConf,
    };
  }

  // Group by strategy
  const stratGroups: Record<string, PaperTrade[]> = {};
  for (const t of trades) {
    if (!stratGroups[t.strategy]) stratGroups[t.strategy] = [];
    stratGroups[t.strategy].push(t);
  }

  // Group by category
  const catGroups: Record<string, PaperTrade[]> = {};
  for (const t of trades) {
    const cat = t.category || 'unknown';
    if (!catGroups[cat]) catGroups[cat] = [];
    catGroups[cat].push(t);
  }

  return {
    byStrategy: Object.entries(stratGroups).map(([k, v]) => calcStats(k, v)).sort((a, b) => b.totalPnl - a.totalPnl),
    byCategory: Object.entries(catGroups).map(([k, v]) => calcStats(k, v)).sort((a, b) => b.totalPnl - a.totalPnl),
    overall:    calcStats('ALL', trades),
  };
}

export function printReport(): void {
  const { byStrategy, byCategory, overall } = generateReport();

  console.log('\n' + '═'.repeat(80));
  console.log('📊 PAPER TRADING REPORT — Polyedge Strategy Performance');
  console.log('═'.repeat(80));
  console.log(`Overall: ${overall.total} trades | ${overall.wins}W ${overall.losses}L | Win rate ${(overall.winRate*100).toFixed(1)}% | P&L $${overall.totalPnl.toFixed(2)} | ROI ${(overall.roi*100).toFixed(1)}%`);

  console.log('\n── By Strategy ──');
  console.log('Strategy'.padEnd(20) + 'Total'.padStart(6) + 'Pend'.padStart(5) + 'W/L'.padStart(8) + 'WinRate'.padStart(9) + 'P&L'.padStart(8) + 'ROI%'.padStart(7) + 'AvgEdge'.padStart(9));
  for (const s of byStrategy) {
    const wl = `${s.wins}/${s.losses}`;
    console.log(
      s.strategy.padEnd(20) +
      String(s.total).padStart(6) +
      String(s.pending).padStart(5) +
      wl.padStart(8) +
      `${(s.winRate*100).toFixed(0)}%`.padStart(9) +
      `$${s.totalPnl.toFixed(2)}`.padStart(8) +
      `${(s.roi*100).toFixed(0)}%`.padStart(7) +
      `${(s.avgEdge*100).toFixed(0)}%`.padStart(9)
    );
  }

  console.log('\n── By Category ──');
  for (const c of byCategory.slice(0, 15)) {
    const wl = `${c.wins}/${c.losses}`;
    console.log(
      c.strategy.padEnd(25) +
      String(c.total).padStart(5) + ' trades | ' +
      wl.padStart(6) + ' | ' +
      `${(c.winRate*100).toFixed(0)}% win | ` +
      `P&L $${c.totalPnl.toFixed(2)}`
    );
  }
  console.log('═'.repeat(80) + '\n');
}
