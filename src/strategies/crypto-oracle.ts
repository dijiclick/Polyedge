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
  bitcoin:       ['bitcoin', 'btc'],
  ethereum:      ['ethereum', 'eth'],
  solana:        ['solana', 'sol'],
  ripple:        ['xrp', 'ripple'],
  binancecoin:   ['bnb', 'binance'],
  dogecoin:      ['dogecoin', 'doge'],
  cardano:       ['cardano', 'ada'],
  'avalanche-2': ['avalanche', 'avax'],
  chainlink:     ['chainlink', 'link'],
  polkadot:      ['polkadot', 'dot'],
  'matic-network': ['polygon', 'matic'],
  litecoin:      ['litecoin', 'ltc'],
  'shiba-inu':   ['shiba', 'shib'],
  sui:           ['sui'],
  toncoin:       ['toncoin', 'ton'],
  near:          ['near'],
  pepe:          ['pepe'],
};

interface LivePrices { [coin: string]: number }

async function fetchLivePrices(): Promise<LivePrices> {
  const ENDPOINTS = [
    // CoinGecko free tier
    `https://api.coingecko.com/api/v3/simple/price?ids=${Object.keys(COIN_IDS).join(',')}&vs_currencies=usd`,
    // Binance spot (BTC, ETH, SOL, BNB only — direct USDT pair)
    null,
  ];

  for (const url of ENDPOINTS) {
    if (!url) break;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json() as Record<string, { usd: number }>;
      const prices: LivePrices = {};
      for (const [id, aliases] of Object.entries(COIN_IDS)) {
        const price = data[id]?.usd;
        if (price) for (const alias of aliases) prices[alias] = price;
      }
      if (Object.keys(prices).length > 0) return prices;
    } catch { continue; }
  }

  // Fallback: Binance individual tickers
  const pairs: Record<string, string[]> = {
    BTCUSDT:  ['bitcoin', 'btc'],
    ETHUSDT:  ['ethereum', 'eth'],
    SOLUSDT:  ['solana', 'sol'],
    BNBUSDT:  ['binancecoin', 'bnb'],
    XRPUSDT:  ['ripple', 'xrp'],
    DOGEUSDT: ['dogecoin', 'doge'],
    ADAUSDT:  ['cardano', 'ada'],
    AVAXUSDT: ['avalanche', 'avax'],
    LINKUSDT: ['chainlink', 'link'],
    DOTUSDT:  ['polkadot', 'dot'],
    MATICUSDT:['polygon', 'matic'],
    LTCUSDT:  ['litecoin', 'ltc'],
    SHIBUSDT: ['shiba', 'shib'],
    SUIUSDT:  ['sui'],
    TONUSDT:  ['toncoin', 'ton'],
    NEARUSDT: ['near'],
    PEPEUSDT: ['pepe'],
  };
  const prices: LivePrices = {};
  await Promise.allSettled(Object.entries(pairs).map(async ([sym, aliases]) => {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return;
    const d = await r.json() as { price: string };
    const p = parseFloat(d.price);
    if (p > 0) for (const a of aliases) prices[a] = p;
  }));
  if (Object.keys(prices).length === 0) throw new Error('All price sources failed');
  return prices;
}

function parsePrice(raw: string): number {
  let v = parseFloat(raw.replace(/,/g, ''));
  const s = raw.toLowerCase();
  if (s.endsWith('k')) v *= 1_000;
  else if (s.endsWith('m')) v *= 1_000_000;
  else if (s.endsWith('b')) v *= 1_000_000_000;
  else if (s.endsWith('t')) v *= 1_000_000_000_000;
  return v;
}

function normalizeCoin(raw: string): string {
  const c = raw.toLowerCase();
  if (c === 'ethereum') return 'eth';
  if (c === 'solana') return 'sol';
  if (c === 'ripple') return 'xrp';
  if (c === 'dogecoin') return 'doge';
  if (c === 'cardano') return 'ada';
  if (c === 'avalanche') return 'avax';
  if (c === 'chainlink') return 'link';
  if (c === 'polkadot') return 'dot';
  if (c === 'polygon') return 'matic';
  if (c === 'litecoin') return 'ltc';
  if (c === 'shiba') return 'shib';
  if (c === 'toncoin') return 'ton';
  return c;
}

const CRYPTO_KEYWORDS = /bitcoin|\bbtc\b|\beth(?:ereum)?\b|\bsol(?:ana)?\b|\bxrp\b|ripple|\bbnb\b|dogecoin|\bdoge\b|cardano|\bada\b|avalanche|\bavax\b|chainlink|\blink\b|polkadot|\bdot\b|polygon|\bmatic\b|litecoin|\bltc\b|shiba|\bshib\b|\bsui\b|toncoin|\bton\b|\bnear\b|\bpepe\b/i;
const PRICE_PATTERN   = /\$\s?([\d,]+(?:\.\d+)?[kmbt]?)/g;
const DIR_ABOVE       = /above|over|exceed|higher|hit|reach|surpass|top|at least/i;
const DIR_BELOW       = /below|under|lower|drop|fall|less than|beneath/i;
const DIR_BETWEEN     = /between/i;

function parsePriceTarget(question: string): { coin: string; target: number; direction: 'above' | 'below' | 'between'; upperBound?: number } | null {
  // 1) Strict: "between $X and $Y"
  const bm = question.match(
    /will\s+(?:the\s+price\s+of\s+)?(bitcoin|btc|eth(?:ereum)?|sol(?:ana)?|xrp|ripple|bnb|doge(?:coin)?|cardano|ada|avax|avalanche|chainlink|link|polkadot|dot|polygon|matic|litecoin|ltc|shiba|shib|sui|toncoin|ton|near|pepe)\s+(?:be\s+|close\s+)?between\s+\$?([\d,]+(?:\.\d+)?[kmbt]?)\s+and\s+\$?([\d,]+(?:\.\d+)?[kmbt]?)/i
  );
  if (bm) {
    console.log(`[crypto-oracle] Parsed (strict-between): ${normalizeCoin(bm[1])} between $${bm[2]} and $${bm[3]} from: ${question.slice(0, 80)}`);
    return { coin: normalizeCoin(bm[1]), target: parsePrice(bm[2]), direction: 'between', upperBound: parsePrice(bm[3]) };
  }

  // 2) Strict: "above/below/hit/reach $X"
  const m = question.match(
    /will\s+(?:the\s+price\s+of\s+)?(bitcoin|btc|eth(?:ereum)?|sol(?:ana)?|xrp|ripple|bnb|doge(?:coin)?|cardano|ada|avax|avalanche|chainlink|link|polkadot|dot|polygon|matic|litecoin|ltc|shiba|shib|sui|toncoin|ton|near|pepe)\s+(?:be\s+|close\s+|stay\s+)?(above|below|exceed|under|over|higher than|lower than|hit|reach)\s+\$?([\d,]+(?:\.\d+)?[kmbt]?)/i
  );
  if (m) {
    const dirRaw = m[2].toLowerCase();
    const direction = (dirRaw.includes('below') || dirRaw.includes('under') || dirRaw.includes('lower'))
      ? 'below' as const : 'above' as const;
    console.log(`[crypto-oracle] Parsed (strict): ${normalizeCoin(m[1])} ${direction} $${m[3]} from: ${question.slice(0, 80)}`);
    return { coin: normalizeCoin(m[1]), target: parsePrice(m[3]), direction };
  }

  // 3) FALLBACK: loose match — any crypto keyword + any dollar amount + optional direction
  const coinMatch = question.match(CRYPTO_KEYWORDS);
  if (!coinMatch) {
    console.log(`[crypto-oracle] No crypto keyword found in: ${question.slice(0, 80)}`);
    return null;
  }
  const coin = normalizeCoin(coinMatch[0]);

  // Extract all dollar amounts
  const prices: number[] = [];
  let pm;
  while ((pm = PRICE_PATTERN.exec(question)) !== null) prices.push(parsePrice(pm[1]));
  if (prices.length === 0) {
    console.log(`[crypto-oracle] No price found in: ${question.slice(0, 80)}`);
    return null;
  }

  // Check for "between" with two prices
  if (DIR_BETWEEN.test(question) && prices.length >= 2) {
    const sorted = [prices[0], prices[1]].sort((a, b) => a - b);
    console.log(`[crypto-oracle] Parsed (fallback-between): ${coin} between $${sorted[0]} and $${sorted[1]} from: ${question.slice(0, 80)}`);
    return { coin, target: sorted[0], direction: 'between', upperBound: sorted[1] };
  }

  // Determine direction from context
  let direction: 'above' | 'below' = 'above'; // default to "above" (will price reach X?)
  if (DIR_BELOW.test(question)) direction = 'below';
  else if (DIR_ABOVE.test(question)) direction = 'above';

  console.log(`[crypto-oracle] Parsed (fallback): ${coin} ${direction} $${prices[0]} from: ${question.slice(0, 80)}`);
  return { coin, target: prices[0], direction };
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
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
    // Paginate to find more crypto markets (up to 1000 total)
    let all: any[] = [];
    for (let offset = 0; offset < 1000; offset += 200) {
      const r = await fetch(`${GAMMA_HOST}/markets?limit=200&active=true&closed=false&offset=${offset}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const batch = await r.json() as any[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 200) break;
    }
    // Word-boundary regex for short keywords to avoid false positives
    // e.g. "eth" must not match "nETHerlands", "sol" must not match "console"
    const cryptoRegex = new RegExp(
      Object.values(COIN_IDS).flat().map(c => `\\b${c}\\b`).join('|'), 'i'
    );
    markets = all.filter(m => {
      const q = (m.question || '').toLowerCase();
      if (!cryptoRegex.test(q)) return false;
      // Filter out false positives: require actual crypto price/value context
      const hasPriceContext = /\$|price|hit|reach|above|below|market cap|fdv|dominan|worth|ath\b|all.time/i.test(q);
      if (!hasPriceContext) return false;
      const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
      const hoursLeft = (endMs - now) / 3_600_000;
      return hoursLeft > 0 && hoursLeft < 8760;  // 1 year — crypto markets are very long-dated, σ√t model handles uncertainty
    });
    console.log(`[crypto] ${markets.length} crypto markets closing in <1yr (from ${all.length} total)`);
    if (markets.length > 0) {
      console.log(`[crypto-oracle] All crypto questions:`);
      for (const mk of markets.slice(0, 10)) console.log(`  → ${mk.question}`);
    } else {
      // Show what was filtered out for debugging
      const cryptoAll = all.filter((mk: any) => {
        const q = (mk.question || '').toLowerCase();
        return cryptoRegex.test(q);
      });
      console.log(`[crypto-oracle] Found ${cryptoAll.length} crypto markets total but none closing in <1yr`);
      if (cryptoAll.length > 0) {
        for (const mk of cryptoAll.slice(0, 5)) {
          const endMs = mk.endDate ? new Date(mk.endDate).getTime() : 0;
          const hoursLeft = (endMs - now) / 3_600_000;
          console.log(`  → [${hoursLeft.toFixed(0)}h left] ${mk.question?.slice(0, 80)}`);
        }
      }
    }
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
    if (!parsed) {
      console.log(`[crypto-oracle] ⚠ Unparseable market: ${m.question}`);
      continue;
    }

    const livePrice = prices[parsed.coin];
    if (!livePrice) continue;

    const hoursLeft = (new Date(m.endDate).getTime() - now) / 3_600_000;

    // Calculate probability using normal distribution
    let confidence: number;
    let buySide: string;

    // Scale volatility by √(days): daily vol ~3% for crypto, grows with time
    const daysLeft = Math.max(hoursLeft / 24, 0.5);
    const scaledVol = 0.03 * Math.sqrt(daysLeft);  // σ√t model

    if (parsed.direction === 'between') {
      const zLow = (parsed.target - livePrice) / (livePrice * scaledVol);
      const zHigh = (parsed.upperBound! - livePrice) / (livePrice * scaledVol);
      const probBetween = normCDF(zHigh) - normCDF(zLow);
      buySide = probBetween > 0.5 ? 'YES' : 'NO';
      confidence = Math.max(probBetween, 1 - probBetween);  // bet-side confidence
      if (confidence < 0.60) {
        console.log(`[crypto] Skip between: ${m.question.slice(0, 60)} — prob ${(confidence * 100).toFixed(1)}% (vol=${(scaledVol*100).toFixed(1)}%)`);
        continue;
      }
    } else {
      const z = (parsed.target - livePrice) / (livePrice * scaledVol);
      const probAbove = 1 - normCDF(z);
      const rawConf = parsed.direction === 'above' ? probAbove : 1 - probAbove;
      buySide = rawConf > 0.5 ? 'YES' : 'NO';
      confidence = Math.max(rawConf, 1 - rawConf);  // bet-side confidence (fixes NO bets showing 0%)
      // Lower threshold for longer-dated markets (more uncertainty = accept lower conf)
      const confThreshold = daysLeft > 7 ? 0.70 : 0.80;
      if (confidence < confThreshold) {
        console.log(`[crypto] Skip: ${m.question.slice(0, 60)} — prob ${(confidence * 100).toFixed(1)}% (need ${(confThreshold*100).toFixed(0)}%+, vol=${(scaledVol*100).toFixed(1)}%)`);
        continue;
      }
    }

    console.log(`\n[crypto] 🎯 EDGE FOUND!`);
    console.log(`  Market: ${m.question}`);
    console.log(`  Live ${parsed.coin.toUpperCase()}: $${livePrice.toLocaleString()} | Target: $${parsed.target.toLocaleString()}${parsed.upperBound ? ` - $${parsed.upperBound.toLocaleString()}` : ''}`);
    console.log(`  Direction: ${parsed.direction} | Outcome: ${buySide} | Probability: ${(confidence * 100).toFixed(1)}%`);
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
    const betSize = Math.min(1.00, usdc * 0.1);

    const msg = `🪙 <b>Crypto Oracle ${ARMED ? '[LIVE]' : '[DRY-RUN]'}</b>\n` +
      `${m.question.slice(0, 80)}\n` +
      `Live: $${livePrice.toLocaleString()} vs Target: $${parsed.target.toLocaleString()}\n` +
      `Probability: ${(confidence * 100).toFixed(1)}% ${parsed.direction}\n` +
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
