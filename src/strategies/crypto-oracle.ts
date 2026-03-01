/**
 * Crypto Price Oracle Strategy
 *
 * Fetches live crypto prices and finds Polymarket markets where the outcome
 * is already mathematically determined (price clearly above/below target).
 * No AI needed — pure price comparison. Near-certain wins.
 *
 * Run: ARMED=true npx tsx src/strategies/crypto-oracle.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 5 * 60_000; // 5 min
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';

const COIN_IDS: Record<string, string[]> = {
  bitcoin:     ['bitcoin', 'btc'],
  ethereum:    ['ethereum', 'eth'],
  solana:      ['solana', 'sol'],
  ripple:      ['xrp', 'ripple'],
  binancecoin: ['bnb', 'binance'],
};

interface LivePrices { [coin: string]: number }

async function fetchLivePrices(): Promise<LivePrices> {
  const ids = Object.keys(COIN_IDS).join(',');
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const data = await r.json() as Record<string, { usd: number }>;
  const prices: LivePrices = {};
  for (const [id, aliases] of Object.entries(COIN_IDS)) {
    const price = data[id]?.usd;
    if (price) for (const alias of aliases) prices[alias] = price;
  }
  return prices;
}

function parsePriceTarget(question: string): { coin: string; target: number; direction: 'above' | 'below' } | null {
  // Match: "Will Bitcoin be above $80,000" / "Will ETH exceed $3500" / "Will BTC stay below $70k"
  const m = question.match(
    /will\s+(bitcoin|btc|eth(?:ereum)?|sol(?:ana)?|xrp|ripple|bnb)\s+(?:be\s+)?(above|below|exceed|under|over|higher than|lower than)\s+\$?([\d,]+(?:\.\d+)?k?)/i
  );
  if (!m) return null;

  let coinRaw = m[1].toLowerCase();
  if (coinRaw === 'ethereum') coinRaw = 'eth';
  if (coinRaw === 'solana') coinRaw = 'sol';
  if (coinRaw === 'ripple') coinRaw = 'xrp';

  let target = parseFloat(m[3].replace(/,/g, ''));
  if (m[3].toLowerCase().endsWith('k')) target *= 1000;

  const dirRaw = m[2].toLowerCase();
  const direction = (dirRaw.includes('below') || dirRaw.includes('under') || dirRaw.includes('lower'))
    ? 'below' : 'above';

  return { coin: coinRaw, target, direction };
}

async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ═══ Crypto Oracle Cycle ═══`);

  const open = getOpenPositions().filter(p => p.strategy === 'crypto-oracle');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[crypto] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  let prices: LivePrices;
  try {
    prices = await fetchLivePrices();
    console.log('[crypto] Live prices:', Object.entries(prices).map(([k, v]) => `${k.toUpperCase()}=$${v.toLocaleString()}`).join(' | '));
  } catch (e: any) {
    console.log('[crypto] Price fetch failed:', e.message);
    return;
  }

  const usdc = ARMED ? await getUsdcBalance() : 20;
  if (ARMED && usdc < 1) { console.log('[crypto] Insufficient balance'); return; }

  // Fetch crypto-related markets closing in <24h
  const now = Date.now();
  let markets: any[] = [];
  try {
    const r = await fetch(`${GAMMA_HOST}/markets?limit=200&active=true&closed=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const all = await r.json() as any[];
    markets = all.filter(m => {
      const q = (m.question || '').toLowerCase();
      const hasCrypto = Object.values(COIN_IDS).flat().some(c => q.includes(c));
      if (!hasCrypto) return false;
      const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
      const hoursLeft = (endMs - now) / 3_600_000;
      return hoursLeft > 0 && hoursLeft < 24;
    });
    console.log(`[crypto] ${markets.length} crypto markets closing in <24h`);
  } catch (e: any) {
    console.log('[crypto] Market fetch failed:', e.message);
    return;
  }

  const heldIds = open.map(p => p.id);
  let bought = 0;

  for (const m of markets) {
    if (open.length + bought >= MAX_POSITIONS) break;
    if (heldIds.includes(m.conditionId)) continue;

    const parsed = parsePriceTarget(m.question);
    if (!parsed) continue;

    const livePrice = prices[parsed.coin];
    if (!livePrice) continue;

    // Calculate edge: how far above/below is current price vs target?
    const pctFromTarget = Math.abs(livePrice - parsed.target) / parsed.target;

    // Outcome: if direction=above and livePrice > target → YES is winning
    const outcomeIsYes = (parsed.direction === 'above' && livePrice > parsed.target) ||
                         (parsed.direction === 'below' && livePrice < parsed.target);
    const buySide = outcomeIsYes ? 'YES' : 'NO';

    // Only bet when price is clearly past target (>2% margin = high confidence)
    const minMargin = 0.02;
    if (pctFromTarget < minMargin) {
      console.log(`[crypto] Skip: ${m.question.slice(0, 60)} — too close (${(pctFromTarget * 100).toFixed(1)}% from target)`);
      continue;
    }

    const hoursLeft = (new Date(m.endDate).getTime() - now) / 3_600_000;

    console.log(`\n[crypto] 🎯 EDGE FOUND!`);
    console.log(`  Market: ${m.question}`);
    console.log(`  Live ${parsed.coin.toUpperCase()}: $${livePrice.toLocaleString()} | Target: $${parsed.target.toLocaleString()}`);
    console.log(`  Direction: ${parsed.direction} | Outcome: ${buySide} | Margin: ${(pctFromTarget * 100).toFixed(1)}%`);
    console.log(`  Closes in: ${hoursLeft.toFixed(1)}h`);

    // Get token IDs from CLOB
    let tokenId: string;
    let entryPrice: number;
    try {
      const clob: any = await getClobMarket(m.conditionId);
      if (!clob.accepting_orders) { console.log('[crypto] Market not accepting orders'); continue; }
      const tokens: any[] = clob.tokens ?? [];
      const token = buySide === 'YES'
        ? tokens.find(t => t.outcome?.toUpperCase() === 'YES') ?? tokens[0]
        : tokens.find(t => t.outcome?.toUpperCase() === 'NO') ?? tokens[1];
      if (!token?.token_id) continue;
      tokenId = token.token_id;
      entryPrice = parseFloat(token.price ?? '0.5');
    } catch (e: any) {
      console.log('[crypto] CLOB error:', e.message);
      continue;
    }

    // Bet size: $2 per crypto oracle trade (near-certain, small size fine)
    const betSize = Math.min(2.00, usdc * 0.1);

    const msg = `🪙 <b>Crypto Oracle ${ARMED ? '[LIVE]' : '[DRY-RUN]'}</b>\n` +
      `${m.question.slice(0, 80)}\n` +
      `Live: $${livePrice.toLocaleString()} vs Target: $${parsed.target.toLocaleString()}\n` +
      `Margin: ${(pctFromTarget * 100).toFixed(1)}% ${parsed.direction} target\n` +
      `Bet: $${betSize.toFixed(2)} on <b>${buySide}</b> @ ${(entryPrice * 100).toFixed(1)}¢\n` +
      `Closes in: ${hoursLeft.toFixed(1)}h`;

    await tg(msg);

    if (ARMED) {
      try {
        const { orderId, shares } = await placeBuy({ tokenId, conditionId: m.conditionId, price: entryPrice, usdcAmount: betSize });
        addPosition({
          id: m.conditionId, tokenId, question: m.question,
          side: buySide, strategy: 'crypto-oracle',
          shares, entryPrice, usdcSpent: betSize,
          entryTime: Date.now(), orderId, status: 'open', dryRun: false,
        });
        await tg(`✅ Crypto oracle order: ${orderId}`);
        bought++;
      } catch (e: any) {
        await tg(`❌ Crypto oracle failed: ${e.message}`);
      }
    } else {
      bought++;
    }
  }

  if (bought === 0) console.log('[crypto] No crypto oracle edges this cycle');
}

export async function runCryptoOracle(): Promise<void> {
  const mode = process.argv.find(a => a === '--monitor');
  if (mode) {
    console.log(`🚀 Crypto Oracle started | ARMED=${ARMED}`);
    await tg(`🪙 Crypto Oracle started | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`);
    await runCycle();
    setInterval(() => runCycle().catch(console.error), SCAN_INTERVAL);
    await new Promise(() => {});
  } else {
    await runCycle();
  }
}

if (process.argv[1]?.endsWith('crypto-oracle.ts') || process.argv[1]?.endsWith('crypto-oracle.js')) {
  runCryptoOracle().catch(console.error);
}
