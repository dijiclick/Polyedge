/**
 * Self-improvement: logs trade results and updates SELF_IMPROVE.md
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOG_PATH     = join('/home/ariad/.openclaw/workspace/polyedge', 'trades.jsonl');
const IMPROVE_PATH = join('/home/ariad/.openclaw/workspace/polyedge', 'SELF_IMPROVE.md');

export interface TradeRecord {
  date:        string;
  question:    string;
  eventType:   string;
  side:        'YES' | 'NO';
  confidence:  number;
  entryPrice:  number;
  bet:         number;
  outcome?:    'WIN' | 'LOSS' | 'PENDING';
  pnl?:        number;
  conditionId: string;
  dryRun:      boolean;
}

export function logTrade(trade: TradeRecord): void {
  try {
    const line = JSON.stringify({ ...trade, ts: Date.now() }) + '\n';
    writeFileSync(LOG_PATH, line, { flag: 'a' });
  } catch { /* silent */ }
}

export function updateSelfImprove(): void {
  try {
    let lines: TradeRecord[] = [];
    try {
      lines = readFileSync(LOG_PATH, 'utf8')
        .split('\n').filter(Boolean)
        .map(l => JSON.parse(l));
    } catch { return; }

    const settled  = lines.filter(t => t.outcome && t.outcome !== 'PENDING');
    const wins     = settled.filter(t => t.outcome === 'WIN').length;
    const losses   = settled.filter(t => t.outcome === 'LOSS').length;
    const totalPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate  = settled.length > 0 ? ((wins / settled.length) * 100).toFixed(1) : 'N/A';

    // Update the performance table in SELF_IMPROVE.md
    let md = readFileSync(IMPROVE_PATH, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    const row   = `| ${today} | ${settled.length} | ${wins} | ${losses} | $${totalPnl.toFixed(2)} | Win rate: ${winRate}% |`;

    // Replace the placeholder row
    md = md.replace(/\| \(no trades yet.*\) \|.*\|/g, row);

    // Update confidence threshold recommendation
    if (settled.length >= 20) {
      const wr = wins / settled.length;
      let note = '';
      if (wr < 0.5)       note = `\n> ⚠️ Win rate ${(wr*100).toFixed(0)}% — consider raising MIN_CONFIDENCE to 0.70`;
      else if (wr > 0.70) note = `\n> ✅ Win rate ${(wr*100).toFixed(0)}% — can try lowering MIN_CONFIDENCE to 0.58`;
      if (note && !md.includes(note.trim())) {
        md = md.replace('## What to Improve Next', note + '\n\n## What to Improve Next');
      }
    }

    writeFileSync(IMPROVE_PATH, md);
    console.log(`[self-improve] Updated: ${wins}W/${losses}L, P&L $${totalPnl.toFixed(2)}`);
  } catch { /* silent */ }
}
