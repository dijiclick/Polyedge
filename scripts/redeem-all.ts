#!/usr/bin/env npx tsx
/**
 * redeem-all.ts
 *
 * Sells ALL open Polymarket positions at the best available bid price.
 *
 * Run:  npx tsx scripts/redeem-all.ts
 *       ARMED=true npx tsx scripts/redeem-all.ts   (actually sell)
 *
 * Without ARMED=true it does a dry-run: shows what it WOULD sell.
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { placeSell, getClient, CLOB_HOST } from '../src/shared/clob.js';
import { tg } from '../src/shared/telegram.js';

// ─── Load env ────────────────────────────────────────────────────────────────

function loadEnv(p: string) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#') || !l.includes('=')) continue;
      const [k, ...rest] = l.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = rest.join('=').trim();
    }
  } catch {}
}
loadEnv(resolve(process.cwd(), '.env'));
loadEnv('/home/ariad/.openclaw/workspace/Polyedge/.env');
loadEnv('/home/ariad/.openclaw/workspace/.env');

// ─── Config ──────────────────────────────────────────────────────────────────

const ARMED = process.env.ARMED === 'true';
const USER  = '0xc92fe1c5f324c58d0be12b8728be18a92375361f';

// ─── Windows curl (WSL2) ─────────────────────────────────────────────────────

function winCurl(url: string, headers?: Record<string, string>): string | null {
  const args = ['-s', '--max-time', '8', url];
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', args, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function winCurlPost(url: string, body: string, headers?: Record<string, string>): string | null {
  const args = ['-s', '--max-time', '15', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', body, url];
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', args, {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Position {
  proxyWallet:  string;
  asset:        string;     // tokenId
  conditionId:  string;
  size:         number;
  avgPrice:     number;
  curPrice:     number;
  redeemable:   boolean;
  title:        string;     // market question
  negativeRisk: boolean;
}

interface OrderbookResponse {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[redeem-all] Mode: ${ARMED ? '🔴 ARMED — will SELL/REDEEM' : '🟡 DRY RUN — preview only'}`);
  console.log(`[redeem-all] User: ${USER}\n`);

  // 1. Fetch all positions from data-api (no auth needed)
  const posUrl = `https://data-api.polymarket.com/positions?user=${USER}&sizeThreshold=0`;
  const rawPositions = winCurl(posUrl);
  if (!rawPositions) {
    console.error('[redeem-all] ERROR: Failed to fetch positions');
    process.exit(1);
  }

  let positions: Position[];
  try {
    positions = JSON.parse(rawPositions);
  } catch (e: any) {
    console.error('[redeem-all] ERROR: Failed to parse positions response:', rawPositions.slice(0, 200));
    process.exit(1);
  }

  // Filter to positions with size > 0
  const openPositions = positions.filter(p => p.size > 0);

  if (openPositions.length === 0) {
    console.log('[redeem-all] No open positions found. Nothing to do.');
    return;
  }

  console.log(`[redeem-all] Found ${openPositions.length} open position(s):\n`);

  // 2. Process each position
  const results: { market: string; shares: number; price: number; status: string }[] = [];

  for (const pos of openPositions) {
    const shares = pos.size;
    const label  = (pos.title || pos.asset).slice(0, 80);

    console.log(`─── ${label}`);
    console.log(`    Token:  ${pos.asset.slice(0, 20)}...`);
    console.log(`    Shares: ${shares.toFixed(4)}`);
    console.log(`    Entry:  ${pos.avgPrice}`);
    console.log(`    Price:  ${pos.curPrice}  Redeemable: ${pos.redeemable}`);

    // ── Case A: LOST (curPrice=0) — worthless, skip ──
    if (pos.curPrice === 0) {
      console.log(`    LOST (worthless) — skipping`);
      results.push({ market: label, shares, price: 0, status: 'LOST (worthless)' });
      continue;
    }

    // ── Case B: WON (curPrice=1, redeemable) — redeem ──
    if (pos.curPrice === 1 && pos.redeemable) {
      if (!ARMED) {
        console.log(`    [DRY RUN] Would REDEEM ${shares.toFixed(4)} winning shares (conditionId=${pos.conditionId.slice(0, 16)}...)`);
        results.push({ market: label, shares, price: 1, status: 'DRY RUN (redeem)' });
        continue;
      }

      try {
        // Try SDK redeemPositions first
        const client = await getClient();
        if (typeof (client as any).redeemPositions === 'function') {
          const resp = await (client as any).redeemPositions([pos.conditionId]);
          console.log(`    ✅ Redeemed via SDK — ${JSON.stringify(resp).slice(0, 120)}`);
          results.push({ market: label, shares, price: 1, status: 'REDEEMED (SDK)' });
        } else {
          // Fallback: raw POST to CLOB /redeem endpoint
          const redeemUrl = `${CLOB_HOST}/redeem`;
          const body = JSON.stringify({ conditionId: pos.conditionId });
          const resp = winCurlPost(redeemUrl, body);
          console.log(`    ✅ Redeemed via POST — ${(resp || '').slice(0, 120)}`);
          results.push({ market: label, shares, price: 1, status: 'REDEEMED (POST)' });
        }
      } catch (e: any) {
        console.error(`    ❌ Redeem failed: ${e.message}`);
        results.push({ market: label, shares, price: 1, status: `ERROR: ${e.message}` });
      }

      console.log();
      continue;
    }

    // ── Case C: Active/trading (0 < curPrice < 1) — sell at best bid ──
    // 2a. Fetch orderbook to get best bid
    const bookUrl = `${CLOB_HOST}/book?token_id=${pos.asset}`;
    const rawBook = winCurl(bookUrl);
    if (!rawBook) {
      console.log(`    Could not fetch orderbook — skipping`);
      results.push({ market: label, shares, price: pos.curPrice, status: 'SKIP (no orderbook)' });
      continue;
    }

    let book: OrderbookResponse;
    try {
      book = JSON.parse(rawBook);
    } catch {
      console.log(`    Could not parse orderbook — skipping`);
      results.push({ market: label, shares, price: pos.curPrice, status: 'SKIP (bad orderbook)' });
      continue;
    }

    if (!book.bids || book.bids.length === 0) {
      console.log(`    No bids in orderbook — skipping`);
      results.push({ market: label, shares, price: pos.curPrice, status: 'SKIP (no bids)' });
      continue;
    }

    const bestBid = parseFloat(book.bids[0].price);
    console.log(`    Best bid: ${bestBid}`);

    if (bestBid <= 0) {
      console.log(`    Best bid is 0 — skipping`);
      results.push({ market: label, shares, price: bestBid, status: 'SKIP (bid=0)' });
      continue;
    }

    // 2b. Sell
    if (!ARMED) {
      console.log(`    [DRY RUN] Would sell ${shares.toFixed(4)} shares @ ${bestBid}`);
      results.push({ market: label, shares, price: bestBid, status: 'DRY RUN (sell)' });
      continue;
    }

    try {
      const orderId = await placeSell({
        tokenId:     pos.asset,
        conditionId: pos.conditionId || undefined,
        shares,
        price:       bestBid,
      });
      console.log(`    ✅ Sold — order: ${orderId}`);
      results.push({ market: label, shares, price: bestBid, status: `SOLD (${orderId})` });
    } catch (e: any) {
      console.error(`    ❌ Sell failed: ${e.message}`);
      results.push({ market: label, shares, price: bestBid, status: `ERROR: ${e.message}` });
    }

    console.log();
  }

  // 3. Summary
  console.log('\n═══ Summary ═══');
  const sold     = results.filter(r => r.status.startsWith('SOLD'));
  const redeemed = results.filter(r => r.status.startsWith('REDEEMED'));
  const lost     = results.filter(r => r.status.startsWith('LOST'));
  const skipped  = results.filter(r => r.status.startsWith('SKIP'));
  const errors   = results.filter(r => r.status.startsWith('ERROR'));
  const dryRuns  = results.filter(r => r.status.startsWith('DRY RUN'));

  console.log(`Total positions: ${results.length}`);
  console.log(`Redeemed: ${redeemed.length}`);
  console.log(`Sold:     ${sold.length}`);
  console.log(`Lost:     ${lost.length}`);
  console.log(`Skipped:  ${skipped.length}`);
  console.log(`Errors:   ${errors.length}`);
  if (dryRuns.length > 0) console.log(`Dry run:  ${dryRuns.length}`);

  // 4. Telegram summary
  const lines = results.map(r =>
    `  ${r.market.slice(0, 50)} | ${r.shares.toFixed(2)} @ ${r.price.toFixed(2)} | ${r.status}`
  );

  const modeLabel = ARMED ? 'ARMED' : 'DRY RUN';
  const summary = `🏷 Redeem-All [${modeLabel}]\n` +
    `${results.length} pos | ${redeemed.length} redeemed | ${sold.length} sold | ${lost.length} lost | ${errors.length} errors\n\n` +
    lines.join('\n');

  await tg(summary);
  console.log('\n[redeem-all] Done.');
}

main().catch(e => {
  console.error('[redeem-all] Fatal error:', e);
  process.exit(1);
});
