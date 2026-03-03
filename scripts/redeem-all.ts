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
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { encodeFunctionData } from 'viem';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

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

// ─── CTF Redemption constants ────────────────────────────────────────────────

const CTF_ADDRESS    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const RELAYER_URL    = 'https://relayer-v2.polymarket.com/';
const CHAIN_ID       = 137;
const PARENT_COLLECTION_ID = ('0x' + '0'.repeat(64)) as `0x${string}`; // bytes32(0)
const INDEX_SETS = [1n, 2n]; // both outcomes for binary markets

const REDEEM_ABI = [{
  name: 'redeemPositions' as const,
  type: 'function' as const,
  inputs: [
    { name: 'collateralToken', type: 'address' as const },
    { name: 'parentCollectionId', type: 'bytes32' as const },
    { name: 'conditionId', type: 'bytes32' as const },
    { name: 'indexSets', type: 'uint256[]' as const },
  ],
  outputs: [],
  stateMutability: 'nonpayable' as const,
}];

let _relayClient: RelayClient | null = null;

async function getRelayClient(): Promise<RelayClient> {
  if (_relayClient) return _relayClient;

  const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk) throw new Error('No POLYMARKET_PRIVATE_KEY or PRIVATE_KEY env var set');
  const provider = new JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
  const wallet = new Wallet(pk.startsWith('0x') ? pk : '0x' + pk, provider);

  // Use builder API credentials (pre-generated via createBuilderApiKey)
  const bKey = process.env.BUILDER_API_KEY || '';
  const bSecret = process.env.BUILDER_SECRET || '';
  const bPassphrase = process.env.BUILDER_PASSPHRASE || '';

  if (!bKey || !bSecret || !bPassphrase) {
    // Fallback: try to create via CLOB client
    console.log('[redeem-all] No BUILDER env vars — trying createBuilderApiKey...');
    const clobClient = await getClient();
    const creds = await (clobClient as any).createBuilderApiKey();
    if (!creds?.key) throw new Error('Failed to create builder API key');
    console.log(`[redeem-all] Builder API key: ${creds.key.slice(0, 8)}...`);
    const config = new BuilderConfig({ localBuilderCreds: { key: creds.key, secret: creds.secret, passphrase: creds.passphrase } });
    _relayClient = new RelayClient(RELAYER_URL, CHAIN_ID, wallet, config, RelayerTxType.PROXY);
    return _relayClient;
  }

  console.log(`[redeem-all] Builder API key: ${bKey.slice(0, 8)}...`);
  const builderConfig = new BuilderConfig({ localBuilderCreds: { key: bKey, secret: bSecret, passphrase: bPassphrase } });
  _relayClient = new RelayClient(RELAYER_URL, CHAIN_ID, wallet, builderConfig, RelayerTxType.PROXY);
  return _relayClient;
}

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

    // ── Case B: WON (curPrice=1, redeemable) — redeem via CTF contract ──
    if (pos.curPrice === 1 && pos.redeemable) {
      if (!ARMED) {
        console.log(`    [DRY RUN] Would REDEEM ${shares.toFixed(4)} winning shares (conditionId=${pos.conditionId.slice(0, 16)}...)`);
        results.push({ market: label, shares, price: 1, status: 'DRY RUN (redeem)' });
        continue;
      }

      try {
        const relay = await getRelayClient();

        const data = encodeFunctionData({
          abi: REDEEM_ABI,
          functionName: 'redeemPositions',
          args: [USDC_E_ADDRESS, PARENT_COLLECTION_ID, pos.conditionId as `0x${string}`, INDEX_SETS],
        });

        const tx = { to: CTF_ADDRESS, data, value: '0' };
        console.log(`    Submitting redeem tx to relayer...`);
        const response = await relay.execute([tx], `Redeem ${label.slice(0, 40)}`);
        console.log(`    Relay txId: ${response.transactionID} | state: ${response.state}`);

        const result = await response.wait();
        if (result) {
          console.log(`    Redeemed — txHash: ${result.transactionHash}`);
          results.push({ market: label, shares, price: 1, status: `REDEEMED (${result.transactionHash?.slice(0, 16)}...)` });
        } else {
          console.log(`    Redeem submitted but status unknown`);
          results.push({ market: label, shares, price: 1, status: `REDEEMED (pending)` });
        }

        // Brief delay between redemptions
        await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        console.error(`    Redeem failed: ${e.message}`);
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
