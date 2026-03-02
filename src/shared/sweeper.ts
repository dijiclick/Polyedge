/**
 * Position Sweeper
 * Periodically checks all open positions and removes resolved ones from tracking.
 * Logs wins/losses to console and Telegram.
 */

import { getOpenPositions, removePosition } from './positions.js';
import { tg } from './telegram.js';
import { spawnSync } from 'child_process';

const SWEEP_INTERVAL = 10 * 60_000; // 10 min

function winCurl(url: string): string | null {
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', ['-s', '--max-time', '8', url], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

async function sweepOnce(): Promise<void> {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  let swept = 0;
  let totalPnl = 0;

  for (const pos of positions) {
    try {
      const raw = winCurl(`https://clob.polymarket.com/markets/${pos.id}`);
      if (!raw) continue;
      const d = JSON.parse(raw);

      const accepting = d.accepting_orders ?? true;
      const closed    = d.closed ?? false;
      const tokens: any[] = d.tokens ?? [];
      const ourToken = tokens.find(t => String(t.token_id) === String(pos.tokenId));
      const price    = ourToken ? parseFloat(ourToken.price) : -1;

      // Resolved: market closed OR price is at absolute extremes (0 or 1)
      const resolved = closed || !accepting || price === 0 || price === 1;
      if (!resolved) continue;

      const finalPrice = price >= 0 ? price : (closed ? 0 : pos.entryPrice);
      const pnl = finalPrice * (pos.shares ?? 0) - pos.usdcSpent;
      totalPnl += pnl;
      swept++;

      const emoji = pnl >= 0 ? '✅' : '❌';
      const msg = `${emoji} Position resolved: ${pos.question?.slice(0, 60)}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(finalPrice * 100).toFixed(0)}¢)`;
      console.log(`[sweeper] ${msg}`);
      await tg(msg);

      removePosition(pos.id);
    } catch (e: any) {
      // skip on error, try next cycle
    }
  }

  if (swept > 0) {
    console.log(`[sweeper] Swept ${swept} resolved positions | cycle PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  }
}

export function startSweeper(): void {
  sweepOnce().catch(console.error);
  setInterval(() => sweepOnce().catch(console.error), SWEEP_INTERVAL);
}
