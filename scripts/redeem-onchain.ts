#!/usr/bin/env npx tsx
/**
 * redeem-onchain.ts
 *
 * Redeems winning Valorant positions from the proxy wallet via Polymarket Relayer.
 * Uses the RelayClient for gasless Safe transactions — no POL needed.
 *
 * Run:  npx tsx scripts/redeem-onchain.ts
 *       ARMED=true npx tsx scripts/redeem-onchain.ts   (actually redeem)
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Interface } from '@ethersproject/abi';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getClient } from '../src/shared/clob.js';
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

const CTF_ADDRESS    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
const RELAYER_URL    = 'https://relayer-v2.polymarket.com/';

// ─── Positions to redeem ─────────────────────────────────────────────────────

const POSITIONS = [
  {
    label:       'Map 2 Winner — Team Liquid WON',
    conditionId: '0xebaec0944d428c355a42ddd89cab548057f2fa605eaceb358595794af9fab530',
    tokenId:     '41064797195138612669715192582530835292881876225667602837907228485552891655813',
  },
  {
    label:       'BO3 Match — Team Liquid WON',
    conditionId: '0xbb4c11cc21bbdcf333a09ac0556689bad2094241cca5bb95bcb8470441e7214b',
    tokenId:     '7315774836195032551726921768485393863650212466291092272827687182139861402639',
  },
];

// ─── Windows curl (WSL2) ─────────────────────────────────────────────────────

function winCurl(url: string): string | null {
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', ['-s', '--max-time', '8', url], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

// ─── ABI encoding ────────────────────────────────────────────────────────────

const CTF_IFACE = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

function encodeRedeemPositions(collateral: string, parentCollectionId: string, conditionId: string, indexSets: number[]): string {
  return CTF_IFACE.encodeFunctionData('redeemPositions', [collateral, parentCollectionId, conditionId, indexSets]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[redeem-onchain] Mode: ${ARMED ? '🔴 ARMED — will REDEEM' : '🟡 DRY RUN — preview only'}`);
  console.log(`[redeem-onchain] User: ${USER}\n`);

  // 1. Fetch current positions to verify state
  const posUrl = `https://data-api.polymarket.com/positions?user=${USER}&sizeThreshold=0`;
  const rawPositions = winCurl(posUrl);
  let userPositions: any[] = [];
  if (rawPositions) {
    try { userPositions = JSON.parse(rawPositions); } catch {}
  }

  const results: { label: string; shares: number; status: string }[] = [];

  for (const pos of POSITIONS) {
    console.log(`─── ${pos.label}`);
    console.log(`    conditionId: ${pos.conditionId.slice(0, 20)}...`);
    console.log(`    tokenId:     ${pos.tokenId.slice(0, 20)}...`);

    // Find matching position
    const match = userPositions.find((p: any) =>
      p.conditionId === pos.conditionId && p.asset === pos.tokenId
    );

    if (match) {
      console.log(`    Shares:      ${match.size}`);
      console.log(`    Price:       ${match.curPrice}  Redeemable: ${match.redeemable}`);
      if (match.curPrice !== 1 || !match.redeemable) {
        console.log(`    ⏭ Not redeemable (price≠1 or not settled) — skipping`);
        results.push({ label: pos.label, shares: match.size, status: 'SKIP (not redeemable)' });
        continue;
      }
    } else {
      console.log(`    (not found in data-api — may already be redeemed)`);
    }

    if (!ARMED) {
      console.log(`    [DRY RUN] Would REDEEM via relayer\n`);
      results.push({ label: pos.label, shares: match?.size ?? 0, status: 'DRY RUN' });
      continue;
    }

    // 2. Redeem via RelayClient (gasless Safe transaction)
    try {
      // Get or create builder API key
      const clobClient = await getClient();
      let builderCreds = {
        key: process.env.POLY_BUILDER_API_KEY || '',
        secret: process.env.POLY_BUILDER_SECRET || '',
        passphrase: process.env.POLY_BUILDER_PASSPHRASE || '',
      };

      if (!builderCreds.key || !builderCreds.secret) {
        console.log('    Creating builder API key...');
        const newKey = await clobClient.createBuilderApiKey();
        builderCreds = {
          key: (newKey as any).key,
          secret: (newKey as any).secret,
          passphrase: (newKey as any).passphrase,
        };
        console.log(`    Builder key: ${builderCreds.key}`);
      }

      // Create ethers wallet with provider (needed by abstract signer constructor)
      const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
      // StaticJsonRpcProvider skips eth_chainId init call; relay does the actual execution
      const provider = new JsonRpcProvider('https://polygon.drpc.org', 137);
      const wallet = new Wallet(pk, provider);
      console.log(`    EOA signer: ${wallet.address}`);

      // Create RelayClient
      const builderConfig = new BuilderConfig({
        localBuilderCreds: builderCreds,
      } as any);

      const relayClient = new RelayClient(
        RELAYER_URL,
        137,
        wallet,
        builderConfig,
        RelayerTxType.PROXY,
      );

      // Encode the redeemPositions call
      const calldata = encodeRedeemPositions(
        USDC_ADDRESS,
        PARENT_COLLECTION_ID,
        pos.conditionId,
        [1, 2],  // both outcomes for binary market
      );

      console.log(`    Submitting to relayer...`);
      const tx = { to: CTF_ADDRESS, data: calldata, value: '0' };
      const response = await relayClient.execute([tx], `Redeem ${pos.label}`);
      console.log(`    Waiting for tx confirmation...`);
      const result = await response.wait();
      console.log(`    ✅ Redeemed! TX: ${JSON.stringify(result).slice(0, 200)}`);
      results.push({ label: pos.label, shares: match?.size ?? 0, status: `REDEEMED (tx: ${(result as any)?.transactionHash?.slice(0, 16) || 'pending'}...)` });

    } catch (e: any) {
      console.error(`    ❌ Redeem failed: ${e.message?.slice(0, 300)}`);
      results.push({ label: pos.label, shares: match?.size ?? 0, status: `ERROR: ${e.message?.slice(0, 100)}` });
    }

    console.log();
  }

  // 3. Summary
  console.log('\n═══ Summary ═══');
  for (const r of results) {
    console.log(`  ${r.label} | ${r.shares} shares | ${r.status}`);
  }

  // 4. Telegram
  const modeLabel = ARMED ? 'ARMED' : 'DRY RUN';
  const redeemed = results.filter(r => r.status.startsWith('REDEEMED')).length;
  const errors   = results.filter(r => r.status.startsWith('ERROR')).length;
  const summary = `🎯 Redeem-Onchain [${modeLabel}]\n` +
    `${results.length} positions | ${redeemed} redeemed | ${errors} errors\n\n` +
    results.map(r => `  ${r.label} → ${r.status}`).join('\n');

  await tg(summary);
  console.log('\n[redeem-onchain] Done.');
}

main().catch(e => {
  console.error('[redeem-onchain] Fatal error:', e);
  process.exit(1);
});
