/**
 * Oracle Lag Arbitrage
 *
 * Find markets where the real-world event is DONE but Polymarket oracle
 * hasn't settled yet (hours to days of lag). Buy YES at 88-98¢, collect $1.00.
 *
 * Run (dry):  npx tsx src/trading/strategies/oracle-arb.ts
 * Run (live): ARMED=true npx tsx src/trading/strategies/oracle-arb.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { kellyBet } from '../shared/kelly.js';
import { addPosition, getOpenPositions, updatePosition } from '../shared/positions.js';
import { getUsdcBalance, placeBuy, placeSell, getClobMarket, getTokenPrice } from '../shared/clob.js';

const ARMED           = process.env.ARMED === 'true';
const MAX_POSITIONS   = parseInt(process.env.MAX_POSITIONS   || '4');
const MIN_YES_PRICE   = parseFloat(process.env.MIN_YES_PRICE  || '0.88');
const MIN_LIQUIDITY   = parseFloat(process.env.MIN_LIQUIDITY  || '200');
const SELL_AT         = parseFloat(process.env.SELL_AT        || '0.98');
const SCAN_INTERVAL   = parseInt(process.env.SCAN_INTERVAL_MIN || '10') * 60_000;
const GAMMA_HOST      = 'https://gamma-api.polymarket.com';

// Descriptions that indicate government-report markets (not real oracle lag)
const SKIP_PATTERNS = [
  'does not publish',
  'financial report of the united states',
  'resolve to the lowest bracket',
  'government report',
];

interface Candidate {
  conditionId: string;
  question:    string;
  yesPrice:    number;
  liquidity:   number;
  volume24h:   number;
  hoursLeft:   number;
  edgePct:     number;
  score:       number;
  tokenId:     string;
}

async function scanMarkets(): Promise<Candidate[]> {
  const now        = Date.now();
  const candidates: Candidate[] = [];

  // Fetch up to 2000 active markets
  for (let offset = 0; offset < 2000; offset += 100) {
    try {
      const res = await fetch(
        `${GAMMA_HOST}/markets?active=true&closed=false&limit=100&offset=${offset}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const batch: any[] = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const m of batch) {
        try {
          const prices = JSON.parse(m.outcomePrices ?? '[]');
          if (prices.length < 2) continue;

          const yes      = parseFloat(prices[0]);
          const endDate  = m.endDate ? new Date(m.endDate) : null;
          if (!endDate || isNaN(yes)) continue;

          const hoursLeft = (endDate.getTime() - now) / 3_600_000;
          const liq       = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
          const vol24h    = parseFloat(m.volume24hr ?? '0');

          // Price filter: 88–98.5%
          if (yes < MIN_YES_PRICE || yes > 0.985) continue;
          // Liquidity filter
          if (liq < MIN_LIQUIDITY) continue;
          // Time filter: expired (oracle lag) OR within 14 days
          if (!(hoursLeft < 0 || (hoursLeft > 0 && hoursLeft <= 2160))) continue; // up to 90 days

          const edgePct     = ((1.0 - yes) / yes) * 100;
          const expiredBonus = hoursLeft < 0 ? 2.0 : 1.0;
          const score       = edgePct * Math.log(liq + 1) * expiredBonus;

          candidates.push({
            conditionId: m.conditionId,
            question:    m.question ?? '',
            yesPrice:    yes,
            liquidity:   liq,
            volume24h:   vol24h,
            hoursLeft,
            edgePct,
            score,
            tokenId:     '',
          });
        } catch {}
      }

      if (batch.length < 100) break;
    } catch (e) {
      console.error(`[oracle-arb] scan error at offset ${offset}:`, (e as Error).message);
      break;
    }
  }

  // Sort by score, take top 50
  candidates.sort((a, b) => b.score - a.score);
  const top50 = candidates.slice(0, 50);

  // Enrich with CLOB data
  const result: Candidate[] = [];
  for (const c of top50) {
    try {
      const clob: any = await getClobMarket(c.conditionId);
      if (!clob.accepting_orders) continue;

      const desc: string = (clob.description ?? '').toLowerCase();
      if (SKIP_PATTERNS.some(p => desc.includes(p))) continue;

      const tokens: any[] = clob.tokens ?? [];
      const yesToken = tokens.find((t: any) =>
        (t.outcome ?? '').toUpperCase() === 'YES'
      ) ?? tokens[0];
      if (!yesToken?.token_id) continue;

      c.tokenId = yesToken.token_id;
      result.push(c);
    } catch {}
  }

  console.log(`[oracle-arb] ${result.length} actionable markets (from ${candidates.length} candidates)`);
  return result;
}

async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ═══ Oracle Arb Cycle ═══`);

  // ── Check open positions for auto-sell ──
  const open = getOpenPositions().filter(p => p.strategy === 'oracle-arb');
  for (const pos of open) {
    try {
      const sellPrice = await getTokenPrice(pos.tokenId, 'SELL');
      console.log(`[oracle-arb] pos: ${pos.question.slice(0, 50)} sell=${sellPrice.toFixed(3)}`);

      if (sellPrice >= SELL_AT) {
        const profit    = (sellPrice - pos.entryPrice) * pos.shares;
        const profitPct = ((sellPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
        const label     = pos.dryRun ? '[DRY-RUN]' : '[LIVE]';

        console.log(`[oracle-arb] AUTO-SELL ${label} profit=$${profit.toFixed(2)} (+${profitPct}%)`);
        await tg(
          `💰 <b>Oracle Arb Auto-Sell ${label}</b>\n` +
          `Market: ${pos.question.slice(0, 80)}\n` +
          `Bought @ ${pos.entryPrice.toFixed(3)} → Sell @ ${sellPrice.toFixed(3)}\n` +
          `Profit: +$${profit.toFixed(2)} (+${profitPct}%)`
        );

        if (ARMED && !pos.dryRun) {
          const sellId = await placeSell({ tokenId: pos.tokenId, shares: pos.shares, price: sellPrice });
          console.log(`[oracle-arb] sell order: ${sellId}`);
        }
        updatePosition(pos.id, { status: 'sold' });
      }
    } catch (e) {
      console.error(`[oracle-arb] pos check error:`, (e as Error).message);
    }
  }

  // ── Check if we have room for new positions ──
  const currentOpen = getOpenPositions().filter(p => p.strategy === 'oracle-arb');
  if (currentOpen.length >= MAX_POSITIONS) {
    console.log(`[oracle-arb] At max positions (${currentOpen.length}/${MAX_POSITIONS})`);
    await tg(`🔍 Oracle Arb — max positions held (${currentOpen.length}/${MAX_POSITIONS}), no new buys`);
    return;
  }

  // ── Scan for new opportunities ──
  const candidates = await scanMarkets();
  const heldIds    = currentOpen.map(p => p.id);
  const fresh      = candidates.filter(c => !heldIds.includes(c.conditionId));

  let usdc = ARMED ? await getUsdcBalance() : 10.65;
  console.log(`[oracle-arb] USDC: $${usdc.toFixed(2)} | candidates: ${fresh.length}`);

  await tg(
    `🔍 <b>Oracle Arb Scan</b>\n` +
    `Actionable: ${candidates.length} | Fresh: ${fresh.length}\n` +
    `Positions: ${currentOpen.length}/${MAX_POSITIONS} | USDC: $${usdc.toFixed(2)}\n` +
    `Mode: ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`
  );

  let bought = 0;
  for (const c of fresh) {
    if (currentOpen.length + bought >= MAX_POSITIONS) break;
    if (usdc < 0.50) break;

    // Oracle arb: TRUE probability ≈ 99.5% (event already happened / near-certain)
    // Market price is what we actually pay — Kelly calculates real edge
    const TRUE_PROB = c.hoursLeft < 0 ? 0.995 : 0.97;  // expired = near-certain, future = high confidence
    const bet = kellyBet({ probability: TRUE_PROB, marketPrice: c.yesPrice, bankroll: usdc });
    if (bet < 0.50) continue;

    const shares      = bet / c.yesPrice;
    const expectedRet = (1.0 - c.yesPrice) * shares;
    const timeLabel   = c.hoursLeft < 0
      ? `⏰ EXPIRED ${Math.abs(c.hoursLeft).toFixed(0)}h ago (oracle lag)`
      : `⏳ Expires in ${c.hoursLeft.toFixed(0)}h`;

    const msg =
      `🟢 <b>Oracle Arb Buy ${ARMED ? '[LIVE]' : '[DRY-RUN]'}</b>\n` +
      `Market: ${c.question.slice(0, 80)}\n` +
      `YES: ${(c.yesPrice * 100).toFixed(1)}¢ | Edge: ${c.edgePct.toFixed(1)}%\n` +
      `${timeLabel}\n` +
      `Bet: $${bet.toFixed(2)} → ${shares.toFixed(2)} shares\n` +
      `Expected: +$${expectedRet.toFixed(2)} on settlement\n` +
      `Liquidity: $${c.liquidity.toFixed(0)}`;

    console.log(msg.replace(/<[^>]+>/g, ''));
    await tg(msg);

    if (ARMED) {
      try {
        const { orderId, shares: filled } = await placeBuy({
          tokenId: c.tokenId, conditionId: c.conditionId, price: c.yesPrice, usdcAmount: bet,
        });
        addPosition({
          id: c.conditionId, tokenId: c.tokenId, question: c.question,
          side: 'YES', strategy: 'oracle-arb',
          shares: filled, entryPrice: c.yesPrice, usdcSpent: bet,
          entryTime: Date.now(), orderId, status: 'open', dryRun: false,
        });
        console.log(`[oracle-arb] order placed: ${orderId}`);
        await tg(`✅ Order placed: ${orderId}`);
        usdc -= bet;
      } catch (e: any) {
        console.error('[oracle-arb] buy failed:', e.message);
        await tg(`❌ Buy failed: ${e.message}`);
      }
    } else {
      addPosition({
        id: c.conditionId, tokenId: c.tokenId, question: c.question,
        side: 'YES', strategy: 'oracle-arb',
        shares, entryPrice: c.yesPrice, usdcSpent: bet,
        entryTime: Date.now(), orderId: `DRY-${Date.now()}`, status: 'open', dryRun: true,
      });
      usdc -= bet;
    }
    bought++;
  }

  if (bought === 0) {
    console.log('[oracle-arb] No actionable opportunities this cycle');
  }
}

/** Run once, used by runner.ts */
export async function runOracleArb(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--monitor') {
    console.log(`🚀 Oracle Arb Monitor started | ARMED=${ARMED} | interval=${SCAN_INTERVAL / 60_000}min`);
    await tg(`🤖 Oracle Arb started | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`);
    await runCycle();
    setInterval(() => runCycle().catch(console.error), SCAN_INTERVAL);
    await new Promise(() => {}); // keep alive
  } else {
    await runCycle();
  }
}

// CLI entry
if (process.argv[1]?.endsWith('oracle-arb.ts') || process.argv[1]?.endsWith('oracle-arb.js')) {
  runOracleArb().then(() => {
    if (process.argv[2] !== '--monitor') process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
