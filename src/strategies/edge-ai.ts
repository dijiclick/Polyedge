/**
 * Edge AI Predictor
 *
 * Scans for Polymarket events ending in 0–3 hours, uses DeepSeek AI to
 * research the current result via web search, and bets if AI is confident
 * — even if the market still shows 50%.
 *
 * Learns accuracy per event type (soccer, crypto, elections, etc.) and
 * improves predictions over time.
 *
 * Run (dry):  npx tsx src/trading/strategies/edge-ai.ts
 * Run (live): ARMED=true npx tsx src/trading/strategies/edge-ai.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { kellyBet } from '../shared/kelly.js';
import { logTrade, updateSelfImprove } from '../shared/self_improve.js';
import { logTradeSignal, resolveTradeSignal, getProfitabilityStats, getRecommendedThreshold } from '../shared/supabase.js';
import { addPosition, getOpenPositions, updatePosition } from '../shared/positions.js';
import { getUsdcBalance, placeBuy, placeSell, getClobMarket, getTokenPrice } from '../shared/clob.js';
import {
  recordPrediction, getAccuracy, getAccuracySummary,
  type EventType,
} from '../shared/patterns.js';
import { ask, search } from '../llm.js';

const ARMED           = process.env.ARMED === 'true';
const MAX_POSITIONS   = parseInt(process.env.MAX_POSITIONS  || '4');
const RISK_LEVEL      = (process.env.RISK_LEVEL  || 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH';
const MIN_LIQUIDITY   = parseFloat(process.env.MIN_LIQUIDITY || '500');   // raised — filters noise
const MIN_MINUTES     = parseInt(process.env.MIN_MINUTES     || '10');    // need time to actually place order
const MAX_AI_CALLS    = parseInt(process.env.MAX_AI_CALLS    || '15');    // max markets analyzed per cycle
const SCAN_INTERVAL   = parseInt(process.env.EDGE_SCAN_MIN   || '15') * 60_000;
const GAMMA_HOST      = 'https://gamma-api.polymarket.com';

// Patterns in market titles that are noise — 5-min automated price direction slots
// AI can never reliably predict these (no real-time data at 1-min granularity)
const NOISE_PATTERNS = [
  /up or down/i,
  /\d+:\d+(am|pm).+\d+:\d+(am|pm)/i,   // "2:30PM-2:35PM"
  /price above/i,
  /price below/i,
  /higher or lower/i,
  /\d+m candle/i,
];

// Minimum AI confidence required to place a trade
const RISK_THRESHOLDS: Record<'LOW' | 'MEDIUM' | 'HIGH', number> = {
  LOW:    0.85,
  MEDIUM: 0.70,
  HIGH:   0.55,
};

interface MarketInfo {
  conditionId: string;
  question:    string;
  description: string;
  yesPrice:    number;
  noPrice:     number;
  liquidity:   number;
  hoursLeft:   number;
  endDate:     Date;
}

interface AIPrediction {
  outcome:    'YES' | 'NO' | 'UNCERTAIN';
  confidence: number;
  eventType:  EventType;
  reasoning:  string;
  keyFact:    string;
}

// ─── Fetch markets expiring in 0–3 hours ────────────────────────────────────
// NOTE: Gamma API returns markets sorted by endDate ascending — this means
// expired markets (past endDates) come FIRST. We must paginate until we've
// passed through all expired markets and collected the 0-3h window.
async function fetchNearExpiryMarkets(): Promise<MarketInfo[]> {
  const now    = Date.now();
  const maxMs  = 72 * 3_600_000;  // 3 days max
  const results: MarketInfo[] = [];
  let   foundFutureMarkets = false;
  let   passedWindow       = false;

  for (let offset = 0; offset < 5000 && !passedWindow; offset += 100) {
    try {
      const res = await fetch(
        `${GAMMA_HOST}/markets?active=true&closed=false&order=endDate&ascending=true&limit=100&offset=${offset}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const batch: any[] = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const m of batch) {
        try {
          const endDate = m.endDate ? new Date(m.endDate) : null;
          if (!endDate) continue;
          const msLeft = endDate.getTime() - now;

          // Still in expired zone — skip but keep paginating
          if (msLeft <= 0) continue;

          // Past the 3h window — stop entirely
          if (msLeft > maxMs) {
            passedWindow = true;
            break;
          }

          // Inside 0-3h window
          foundFutureMarkets = true;

          // Skip markets closing too soon to act on
          const minutesLeft = msLeft / 60_000;
          if (minutesLeft < MIN_MINUTES) continue;

          // Skip automated noise markets (5-min price direction slots)
          const q = m.question ?? '';
          if (NOISE_PATTERNS.some(p => p.test(q))) continue;

          const prices = JSON.parse(m.outcomePrices ?? '[]');
          if (prices.length < 2) continue;
          const yes = parseFloat(prices[0]);
          const no  = parseFloat(prices[1]);
          if (isNaN(yes) || isNaN(no)) continue;

          const liq = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
          if (liq < MIN_LIQUIDITY) continue;
          // Skip near-certain markets (no AI edge needed)
          if (yes >= 0.90 || no >= 0.90) continue;

          results.push({
            conditionId: m.conditionId,
            question:    m.question ?? '',
            description: '',
            yesPrice:    yes,
            noPrice:     no,
            liquidity:   liq,
            hoursLeft:   msLeft / 3_600_000,
            endDate,
          });
        } catch {}
      }

      if (batch.length < 100) break;

      // Early exit: if we found future markets and now past window, we're done
      if (foundFutureMarkets && passedWindow) break;

    } catch (e) {
      console.error('[edge-ai] fetch error at offset', offset, ':', (e as Error).message);
      break;
    }
  }

  // Sort by liquidity descending (highest liquidity = most reliable market)
  // then cap at MAX_AI_CALLS to limit expensive AI+search calls per cycle
  results.sort((a, b) => b.liquidity - a.liquidity);
  const top = results.slice(0, MAX_AI_CALLS);

  console.log(`[edge-ai] ${results.length} qualifying markets in 0-3h window → analyzing top ${top.length} by liquidity`);

  // Re-sort top candidates by urgency (most urgent first)
  top.sort((a, b) => a.hoursLeft - b.hoursLeft);
  return top;
}

// ─── Classify event type from question text ──────────────────────────────────
function classifyEventType(question: string): EventType {
  const q = question.toLowerCase();
  if (/soccer|football|premier league|la liga|bundesliga|serie a|ligue 1|champions league|euro|copa|world cup|mls|bundesliga/.test(q)) return 'soccer_match';
  if (/nba|basketball|lakers|celtics|knicks|warriors|heat|bucks|points|rebounds|assists/.test(q)) return 'basketball_game';
  if (/nfl|super bowl|touchdown|quarterback|patriots|chiefs|eagles|ravens|49ers|playoffs/.test(q)) return 'american_football';
  if (/election|vote|president|senator|governor|primary|ballot|congress|parliament/.test(q)) return 'election';
  if (/bitcoin|btc|eth|ethereum|crypto|price|usdc|sol|bnb|xrp|matic|\$[0-9]/.test(q)) return 'crypto_price';
  if (/award|oscar|grammy|emmy|golden globe|winner|best actor|best film|mvp|trophy|championship/.test(q)) return 'sports_award';
  if (/weather|temperature|rain|snow|hurricane|storm|flood|celsius|fahrenheit/.test(q)) return 'weather';
  return 'general';
}

// ─── Call AI to analyze a market ────────────────────────────────────────────
async function analyzeMarket(market: MarketInfo): Promise<AIPrediction> {
  const minutesLeft = Math.round(market.hoursLeft * 60);
  const eventType   = classifyEventType(market.question);
  const accuracy    = getAccuracy(eventType);

  let searchResults = 'No search results available.';
  const closeDate   = new Date(market.endDate).toUTCString();
  try {
    // Targeted prompt: ask for exact factual outcome, not similar events
    const searchQuery = [
      `Polymarket prediction market question: "${market.question}"`,
      `This market closes: ${closeDate}`,
      `Current YES price: ${(market.yesPrice * 100).toFixed(1)}%`,
      `I need the EXACT current status/result for this specific question only.`,
      `Do NOT discuss similar events or general trends.`,
      `What is the factual current outcome or latest confirmed news directly answering: ${market.question}`,
    ].join('\n');
    const result = await search(searchQuery);
    searchResults = result.answer || 'No results found.';
  } catch (e) {
    console.error('[edge-ai] search error:', (e as Error).message);
  }

  const prompt = `You are a prediction market analyst. Analyze this Polymarket question:
"${market.question}"

Market closes in: ${minutesLeft} minutes (${new Date(market.endDate).toUTCString()})
Current YES price: ${(market.yesPrice * 100).toFixed(1)}%
Current NO price:  ${(market.noPrice * 100).toFixed(1)}%
${market.description ? `\nResolution criteria: ${market.description.slice(0, 300)}` : ''}

Web search results:
${searchResults}

Historical AI accuracy for ${eventType} markets: ${(accuracy * 100).toFixed(0)}%

Based on the evidence, what is the most likely outcome?
Respond ONLY with valid JSON (no markdown, no text outside the JSON object):
{
  "outcome": "YES" or "NO" or "UNCERTAIN",
  "confidence": 0.0 to 1.0,
  "eventType": "soccer_match|basketball_game|american_football|election|crypto_price|sports_award|weather|general",
  "reasoning": "1-2 sentence explanation of your reasoning",
  "keyFact": "the single most important fact from the search results that drives your prediction"
}`;

  try {
    const raw = await ask(prompt, { temperature: 0.1 });

    // 1. Try strict JSON parse first
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        outcome:    (parsed.outcome === 'YES' || parsed.outcome === 'NO') ? parsed.outcome : 'UNCERTAIN',
        confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence ?? '0'))),
        eventType:  parsed.eventType ?? eventType,
        reasoning:  parsed.reasoning ?? '',
        keyFact:    parsed.keyFact ?? '',
      };
    }

    // 2. Fallback: extract YES/NO and confidence from prose response
    const upper = raw.toUpperCase();
    let outcome: 'YES' | 'NO' | 'UNCERTAIN' = 'UNCERTAIN';
    let confidence = 0;

    // Look for explicit YES/NO verdict
    if (/\b(OUTCOME|VERDICT|PREDICTION|RESULT)\s*[:\-=]\s*YES\b/.test(upper) || /\bWILL\s+(?:WIN|HAPPEN|OCCUR|SCORE)\b/.test(upper)) outcome = 'YES';
    else if (/\b(OUTCOME|VERDICT|PREDICTION|RESULT)\s*[:\-=]\s*NO\b/.test(upper) || /\bWILL\s+NOT\b/.test(upper)) outcome = 'NO';
    else if (upper.includes('"YES"') || (upper.indexOf('YES') > upper.indexOf('NO') && !upper.includes('NOT YES'))) outcome = 'YES';
    else if (upper.includes('"NO"')) outcome = 'NO';

    // Extract confidence number (e.g., "confidence: 0.78" or "78%" or "high confidence")
    const confMatch = raw.match(/confidence[:\s]+([0-9.]+)/i) ?? raw.match(/([0-9]+)%\s*(?:confident|probability|chance)/i);
    if (confMatch) {
      const v = parseFloat(confMatch[1]);
      confidence = v > 1 ? v / 100 : v;
    } else if (/high\s+confidence|very\s+likely|almost\s+certain/i.test(raw)) confidence = 0.82;
    else if (/moderate|fairly\s+likely|probably/i.test(raw)) confidence = 0.70;
    else if (/uncertain|unclear|could\s+go\s+either/i.test(raw)) confidence = 0.52;

    // Extract reasoning (first sentence that's not too short)
    const sentences = raw.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 30);
    const reasoning = sentences[0] ?? '';
    const keyFact   = sentences[1] ?? '';

    if (outcome !== 'UNCERTAIN' && confidence >= 0.60) {
      console.log(`[edge-ai] Prose parse → ${outcome} @ ${(confidence*100).toFixed(0)}%`);
    }

    return { outcome, confidence, eventType, reasoning, keyFact };
  } catch (e) {
    console.error('[edge-ai] AI parse error:', (e as Error).message);
    return { outcome: 'UNCERTAIN', confidence: 0, eventType, reasoning: 'Parse failed', keyFact: '' };
  }
}

// ─── Main scan + trade cycle ─────────────────────────────────────────────────
async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ═══ Edge AI Cycle ═══`);

  // ── Check open edge-ai positions for resolution ──
  const open = getOpenPositions().filter(p => p.strategy === 'edge-ai');
  for (const pos of open) {
    try {
      const sellPrice = await getTokenPrice(pos.tokenId, 'SELL');
      if (sellPrice >= 0.97) {
        const profit = (sellPrice - pos.entryPrice) * pos.shares;
        const label  = pos.dryRun ? '[DRY-RUN]' : '[LIVE]';
        console.log(`[edge-ai] Closing position ${label} profit=$${profit.toFixed(2)}`);
        await tg(
          `💰 <b>Edge AI Close ${label}</b>\n` +
          `Market: ${pos.question.slice(0, 80)}\n` +
          `Entry: ${(pos.entryPrice * 100).toFixed(1)}¢ → Sell: ${(sellPrice * 100).toFixed(1)}¢\n` +
          `Profit: +$${profit.toFixed(2)}\n` +
          `AI confidence was: ${((pos.aiConfidence ?? 0) * 100).toFixed(0)}%`
        );
        if (ARMED && !pos.dryRun) {
          await placeSell({ tokenId: pos.tokenId, shares: pos.shares, price: sellPrice });
        }
        updatePosition(pos.id, { status: 'sold' });
      }
    } catch {}
  }

  // ── Check if room for new positions ──
  const currentOpen = getOpenPositions().filter(p => p.strategy === 'edge-ai');
  if (currentOpen.length >= MAX_POSITIONS) {
    console.log(`[edge-ai] At max positions (${currentOpen.length}/${MAX_POSITIONS})`);
    return;
  }

  // ── Fetch near-expiry markets ──
  const markets  = await fetchNearExpiryMarkets();
  const heldIds  = currentOpen.map(p => p.id);
  const fresh    = markets.filter(m => !heldIds.includes(m.conditionId));

  // Get CLOB balance — if $0, try activity estimate, else use configured OVERRIDE_BALANCE
  let usdc = ARMED ? await getUsdcBalance() : 10.65;
  const balanceOverride = parseFloat(process.env.BALANCE_OVERRIDE ?? '0');
  if (ARMED && usdc < 0.50 && balanceOverride > 0) {
    console.log(`[edge-ai] Using BALANCE_OVERRIDE=$${balanceOverride} (CLOB shows $0)`);
    usdc = balanceOverride;
  }
  if (ARMED && usdc < 0.50) {
    // Fallback: estimate from recent activity (sells - buys in last 7 days)
    try {
      const addr = process.env.FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || '';
      const res  = await fetch(`https://data-api.polymarket.com/activity?user=${addr.toLowerCase()}&limit=50`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const acts: any[] = await res.json();
        let net = 0;
        const weekAgo = Date.now() / 1000 - 7 * 86400;
        for (const a of acts) {
          if (a.timestamp < weekAgo) break;
          const amt = parseFloat(a.usdcAmount ?? a.amount ?? 0);
          if (a.type === 'REDEEM' || (a.type === 'TRADE' && a.side?.startsWith('SELL'))) net += amt;
          if (a.type === 'TRADE' && a.side?.startsWith('BUY')) net -= amt;
        }
        if (net > 0.50) {
          console.log(`[edge-ai] Balance via activity estimate: $${net.toFixed(2)}`);
          usdc = net;
        }
      }
    } catch {}
  }
  // Self-improve: get recommended threshold from Supabase results
  let threshold = RISK_THRESHOLDS[RISK_LEVEL];
  threshold = await getRecommendedThreshold(threshold);

  await tg(
    `🧠 <b>Edge AI Scan</b>\n` +
    `Markets 0–3h: ${fresh.length} | Positions: ${currentOpen.length}/${MAX_POSITIONS}\n` +
    `Risk: ${RISK_LEVEL} (need ${(threshold * 100).toFixed(0)}%+ confidence)\n` +
    `USDC: $${usdc.toFixed(2)} | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`
  );

  let bought = 0;
  const seenQuestions = new Set<string>();  // deduplicate near-identical questions

  for (const market of fresh) {
    if (currentOpen.length + bought >= MAX_POSITIONS) break;
    if (usdc < 0.50) break;

    // Skip duplicate questions (same match, different sub-market IDs)
    const qKey = market.question.toLowerCase().trim();
    if (seenQuestions.has(qKey)) continue;
    seenQuestions.add(qKey);

    console.log(`\n[edge-ai] Analyzing: ${market.question.slice(0, 70)}`);
    console.log(`[edge-ai] Closes in ${(market.hoursLeft * 60).toFixed(0)}min | YES=${(market.yesPrice * 100).toFixed(1)}%`);

    // Get CLOB description for better context
    try {
      const clob: any = await getClobMarket(market.conditionId);
      if (!clob.accepting_orders) continue;
      market.description = (clob.description ?? '').slice(0, 400);

      // Get token IDs
      const tokens: any[] = clob.tokens ?? [];
      const yesToken = tokens.find((t: any) => (t.outcome ?? '').toUpperCase() === 'YES') ?? tokens[0];
      const noToken  = tokens.find((t: any) => (t.outcome ?? '').toUpperCase() === 'NO')  ?? tokens[1];
      if (!yesToken?.token_id) continue;

      // AI analysis
      const prediction = await analyzeMarket(market);
      console.log(`[edge-ai] AI: ${prediction.outcome} @ ${(prediction.confidence * 100).toFixed(0)}% confidence`);
      console.log(`[edge-ai] Key fact: ${prediction.keyFact.slice(0, 100)}`);

      if (prediction.outcome === 'UNCERTAIN' || prediction.confidence < threshold) {
        console.log(`[edge-ai] Skip: confidence ${(prediction.confidence * 100).toFixed(0)}% < threshold ${(threshold * 100).toFixed(0)}%`);
        continue;
      }

      // Determine which side to buy
      const buySide    = prediction.outcome;
      const targetToken = buySide === 'YES' ? yesToken : noToken;
      if (!targetToken?.token_id) {
        console.log(`[edge-ai] Skip: no ${buySide} token found for this market`);
        continue;
      }
      const tokenId    = targetToken.token_id;
      const entryPrice = buySide === 'YES' ? market.yesPrice : market.noPrice;

      // AI confidence = true probability estimate; entryPrice = what we actually pay
      const bet    = kellyBet({ probability: prediction.confidence, marketPrice: entryPrice, bankroll: usdc, maxBet: 1.0 });
      const shares = bet / entryPrice;
      const minutesLeft = Math.round(market.hoursLeft * 60);

      const msg =
        `🧠 <b>Edge AI Signal ${ARMED ? '[LIVE]' : '[DRY-RUN]'}</b>\n` +
        `Market: ${market.question.slice(0, 80)}\n` +
        `Closes in: ${minutesLeft}min | YES: ${(market.yesPrice * 100).toFixed(1)}%\n\n` +
        `AI says: <b>${prediction.outcome}</b> (${(prediction.confidence * 100).toFixed(0)}% confident)\n` +
        `Key fact: ${prediction.keyFact.slice(0, 150)}\n` +
        `Reasoning: ${prediction.reasoning.slice(0, 150)}\n\n` +
        `Bet: $${bet.toFixed(2)} on <b>${buySide}</b> @ ${(entryPrice * 100).toFixed(1)}¢\n` +
        `Risk level: ${RISK_LEVEL} | Event type: ${prediction.eventType}\n` +
        `Historical accuracy: ${(getAccuracy(prediction.eventType) * 100).toFixed(0)}%`;

      console.log(msg.replace(/<[^>]+>/g, ''));
      await tg(msg);

      // Record prediction in pattern memory
      recordPrediction({
        eventType:        prediction.eventType,
        question:         market.question,
        predictedOutcome: prediction.outcome,
        confidence:       prediction.confidence,
      });

      if (ARMED) {
        try {
          const { orderId, shares: filled } = await placeBuy({ tokenId, conditionId: market.conditionId, price: entryPrice, usdcAmount: bet });
          addPosition({
            id: market.conditionId, tokenId, question: market.question,
            side: buySide, strategy: 'edge-ai',
            shares: filled, entryPrice, usdcSpent: bet,
            entryTime: Date.now(), orderId, status: 'open', dryRun: false,
            aiConfidence: prediction.confidence, aiReasoning: prediction.reasoning,
          });
          await tg(`✅ Edge AI order placed: ${orderId}`);
          usdc -= bet;
        } catch (e: any) {
          await tg(`❌ Edge AI buy failed: ${e.message}`);
        }
      } else {
        addPosition({
          id: market.conditionId, tokenId, question: market.question,
          side: buySide, strategy: 'edge-ai',
          shares, entryPrice, usdcSpent: bet,
          entryTime: Date.now(), orderId: `DRY-EDGE-${Date.now()}`, status: 'open', dryRun: true,
          aiConfidence: prediction.confidence, aiReasoning: prediction.reasoning,
        });
        usdc -= bet;
      }
      // Log to local file + Supabase for profitability tracking
      logTrade({
        date:        new Date().toISOString(),
        question:    market.question,
        eventType:   classifyEventType(market.question),
        side:        prediction.outcome as 'YES' | 'NO',
        confidence:  prediction.confidence,
        entryPrice,
        bet,
        outcome:     'PENDING',
        conditionId: market.conditionId,
        dryRun:      !ARMED,
      });
      // Supabase: non-blocking
      logTradeSignal({
        conditionId: market.conditionId,
        question:    market.question,
        eventType:   classifyEventType(market.question),
        side:        prediction.outcome as 'YES' | 'NO',
        confidence:  prediction.confidence,
        entryPrice,
        bet,
        reasoning:   prediction.reasoning ?? '',
        keyFact:     prediction.keyFact ?? '',
        dryRun:      !ARMED,
      }).catch(() => {});
      bought++;

    } catch (e) {
      console.error(`[edge-ai] error analyzing ${market.conditionId}:`, (e as Error).message);
    }
  }

  // Update self-improvement log after each cycle
  updateSelfImprove();

  if (bought === 0 && fresh.length > 0) {
    console.log(`[edge-ai] Analyzed ${Math.min(fresh.length, 10)} markets — none met confidence threshold (${(threshold * 100).toFixed(0)}%)`);
  } else if (fresh.length === 0) {
    console.log('[edge-ai] No markets expiring within 3h right now');
    await tg('🧠 Edge AI — no markets expiring within 3 hours this cycle');
  }

  // Pattern accuracy summary
  const summary = getAccuracySummary();
  if (summary !== 'No history yet') {
    console.log(`[edge-ai] Pattern memory: ${summary}`);
  }
}

/** Run, used by runner.ts */
export async function runEdgeAI(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--monitor') {
    console.log(`🚀 Edge AI Monitor started | ARMED=${ARMED} | risk=${RISK_LEVEL} | interval=${SCAN_INTERVAL / 60_000}min`);
    await tg(`🧠 Edge AI started | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'} | Risk: ${RISK_LEVEL}`);
    await runCycle();
    setInterval(() => runCycle().catch(console.error), SCAN_INTERVAL);
    await new Promise(() => {}); // keep alive
  } else {
    await runCycle();
  }
}

// CLI entry
if (process.argv[1]?.endsWith('edge-ai.ts') || process.argv[1]?.endsWith('edge-ai.js')) {
  runEdgeAI().then(() => {
    if (process.argv[2] !== '--monitor') process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
