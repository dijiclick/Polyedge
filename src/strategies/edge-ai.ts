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
const MAX_POSITIONS   = parseInt(process.env.MAX_POSITIONS  || '8');
const RISK_LEVEL      = (process.env.RISK_LEVEL  || 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH';
const MIN_LIQUIDITY   = parseFloat(process.env.MIN_LIQUIDITY || '200');   // lowered: $200 min — more qualifying markets
const MIN_MINUTES     = parseInt(process.env.MIN_MINUTES     || '10');    // need time to actually place order
const MAX_AI_CALLS    = parseInt(process.env.MAX_AI_CALLS    || '25');    // more markets per cycle
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
  /spread[:\s-]/i,                       // sports spread bets — pure noise
  /\(-\d+\.?\d*\)/,                      // team (-1.5) handicap
  /total.*over/i,                        // over/under totals
  /over\/under/i,
  /o\/u\s+\d/i,                          // O/U 2.5 etc
  /first.*goal.*scorer/i,                // very hard to predict
  /anytime goalscorer/i,
];

// Major leagues Perplexity actually has data on — skip obscure ones
const KNOWN_LEAGUES = [
  // Soccer
  /premier league|epl/i,
  /la liga|laliga/i,
  /bundesliga/i,
  /serie a/i,
  /ligue 1/i,
  /champions league|ucl/i,
  /europa league|uel/i,
  /mls|major league soccer/i,
  /copa del rey/i,
  /fa cup/i,
  // US Sports
  /\bnhl\b|\bice hockey\b/i,
  /\bnba\b|\bbasketball\b/i,
  /\bnfl\b/i,
  // Teams that indicate major leagues
  /manchester|arsenal|chelsea|liverpool|tottenham|barcelona|real madrid|atletico|juventus|inter milan|ac milan|psg|bayern|dortmund|ajax/i,
  /lakers|celtics|warriors|heat|bucks|nets|knicks|spurs|mavericks|suns/i,
  /golden knights|maple leafs|bruins|rangers|penguins|avalanche|oilers|flames/i,
  // Non-soccer (always worth checking)
  /bitcoin|ethereum|btc|eth|crypto/i,
  /election|vote|president|senate|congress/i,
  /oscar|grammy|emmy|golden globe|award/i,
  /will.*win.*championship|will.*win.*title|will.*win.*cup/i,
  // Tennis
  /\btennis\b|atp|wta|indian wells|australian open|french open|wimbledon|us open|roland garros/i,
  // F1/Motorsport
  /formula\s*1|f1|grand prix|verstappen|hamilton|leclerc|norris|red bull racing/i,
  // UFC/MMA
  /\bufc\b|\bmma\b|ufc \d+|fight night|bellator|octagon/i,
  // Golf
  /\bgolf\b|\bpga\b|masters tournament|the open|ryder cup|us open golf/i,
  // Boxing
  /\bboxing\b|heavyweight|tyson|fury|usyk|canelo|undisputed/i,
  // Baseball/MLB
  /\bmlb\b|yankees|red sox|dodgers|astros|braves|padres|phillies|mets|cubs|world series/i,
  // NCAA
  /\bncaa\b|march madness|final four|college basketball|college football/i,
  // Cricket
  /\bcricket\b|\bipl\b|t20|big bash|cricket world cup|ashes|test match/i,
  // Rugby
  /\brugby\b|six nations|rugby world cup|super rugby|nrl|premiership rugby/i,
  // Esports
  /\besports?\b|league of legends|\blol\b worlds|dota|valorant|counter.?strike|\bcs2?\b/i,
];

function isKnownLeagueOrType(question: string): boolean {
  return KNOWN_LEAGUES.some(p => p.test(question));
}

// Minimum AI confidence required to place a trade
const RISK_THRESHOLDS: Record<'LOW' | 'MEDIUM' | 'HIGH', number> = {
  LOW:    0.70,
  MEDIUM: 0.55,  // lowered: 60% was still too restrictive, 0 signals
  HIGH:   0.48,
};

// Per-event-type confidence overrides (some events are more predictable)
const EVENT_THRESHOLDS: Partial<Record<string, number>> = {
  crypto_price:      0.53,  // lowered: crypto markets have clear price data
  election:          0.55,  // lowered: from 0.60
  sports_award:      0.53,  // lowered: often confirmed before market closes
  soccer_match:      0.53,  // lowered: live scores available, from 0.58
  basketball_game:   0.53,  // lowered: live scores available, from 0.58
  general:           0.53,  // lowered: from 0.55
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
  const maxMs  = 24 * 3_600_000;  // 24h window — catch more markets, especially during low-activity hours
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

          // Past the 6h window — stop entirely
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

          // Skip obscure leagues Perplexity has no data on — wastes API calls
          // Only skip sports games (contain "win on" pattern) if not a known league
          const isSportsGame = /win on \d{4}|vs\.|at \w+ (fc|sc|united|city|club)/i.test(q);
          if (isSportsGame && !isKnownLeagueOrType(q)) continue;

          const prices = JSON.parse(m.outcomePrices ?? '[]');
          if (prices.length < 2) continue;
          const yes = parseFloat(prices[0]);
          const no  = parseFloat(prices[1]);
          if (isNaN(yes) || isNaN(no)) continue;

          const liq = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
          if (liq < MIN_LIQUIDITY) continue;
          // Skip near-certain markets (no AI edge needed)
          if (yes >= 0.92 || no >= 0.92) continue;

          // Skip 50/50 markets closing > 2h from now — event hasn't happened yet,
          // Perplexity will just say "no results". Focus on:
          //   a) Skewed markets (>65¢ or <35¢) — market already has info  
          //   b) Near-expiry (< 90 min) — event likely completed
          const isSkewed = yes > 0.55 || yes < 0.45;       // relaxed: catch more markets
          const isNearExpiry = minutesLeft < 720;          // 12h — wider window catches more markets during off-peak UTC hours
          const isHighValue = isKnownLeagueOrType(q);      // crypto/elections/major sports — always worth checking
          if (!isSkewed && !isNearExpiry && !isHighValue) continue;

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

  // Split into urgent (≤45min, game likely in progress) and normal
  const urgent = results.filter(m => m.hoursLeft <= 0.75);
  const normal = results.filter(m => m.hoursLeft > 0.75);

  // Sort urgent by liquidity, normal by liquidity too
  urgent.sort((a, b) => b.liquidity - a.liquidity);
  normal.sort((a, b) => b.liquidity - a.liquidity);

  // Urgent markets first — they're live/finishing, highest edge potential
  const top = [...urgent, ...normal].slice(0, MAX_AI_CALLS);

  const liveCount = urgent.length;
  console.log(`[edge-ai] ${results.length} qualifying markets in 0-24h window (${liveCount} live/ending ≤45min) → analyzing top ${top.length}`);
  if (top.length > 0) {
    console.log(`[edge-ai] Top markets:`);
    for (const mk of top.slice(0, 5)) {
      console.log(`  → [${(mk.hoursLeft * 60).toFixed(0)}min] YES=${(mk.yesPrice * 100).toFixed(0)}% liq=$${mk.liquidity.toFixed(0)} ${mk.question.slice(0, 70)}`);
    }
  }
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
// Parse ESPN score data and return direct prediction (no LLM needed)
function parseESPNScore(espnData: string, question: string): AIPrediction | null {
  if (!espnData.includes('ESPN scores hit') && !espnData.includes('Live/recent scores')) return null;

  const lines = espnData.split('\n').filter(l => l.includes('-') && l.includes(':'));
  const q = question.toLowerCase();

  // Extract team being asked about from question
  // "Will Bucks win" → looking for "Bucks" in score lines
  const teamMatch = question.match(/Will\s+(.+?)\s+(win|lose|score|beat)/i);
  const targetTeam = teamMatch?.[1]?.toLowerCase() ?? '';

  for (const line of lines) {
    // Format: "NBA: Bulls 82-95 Bucks [Q4 3:42]" or "EPL: Arsenal 2-0 Chelsea [FT]"
    const m = line.match(/:\s*(.+?)\s+(\d+)-(\d+)\s+(.+?)\s+\[(.+)\]/);
    if (!m) continue;

    const [, awayTeam, awayScore, homeScore, homeTeam, status] = m;
    const away = parseInt(awayScore), home = parseInt(homeScore);
    const isFinal = /FT|Final|Full Time/i.test(status);
    const isLate  = /Q4|3rd|OT|90\+|\d{2}:\d{2}/.test(status) && !isFinal;

    // Find if target team is in this game
    const awayNorm = awayTeam.toLowerCase();
    const homeNorm = homeTeam.toLowerCase();
    let teamIsHome: boolean | null = null;

    if (targetTeam && homeNorm.includes(targetTeam.split(' ')[0])) teamIsHome = true;
    else if (targetTeam && awayNorm.includes(targetTeam.split(' ')[0])) teamIsHome = false;
    else if (targetTeam && q.includes(homeNorm.split(' ')[0])) teamIsHome = true;
    else if (targetTeam && q.includes(awayNorm.split(' ')[0])) teamIsHome = false;

    if (teamIsHome === null) continue;

    const teamScore   = teamIsHome ? home : away;
    const oppScore    = teamIsHome ? away : home;
    const teamName    = teamIsHome ? homeTeam : awayTeam;
    const diff = teamScore - oppScore;

    if (isFinal) {
      // Confirmed result
      const outcome: 'YES' | 'NO' = diff > 0 ? 'YES' : 'NO';
      return {
        outcome, confidence: 0.95, eventType: 'soccer_match',
        reasoning: `Final score confirmed: ${awayTeam} ${away}-${home} ${homeTeam}. ${teamName} ${diff > 0 ? 'WON' : 'LOST'}.`,
        keyFact: line,
      };
    } else if (isLate && Math.abs(diff) >= 2) {
      // Strong lead late in game
      const outcome: 'YES' | 'NO' = diff > 0 ? 'YES' : 'NO';
      const conf = Math.min(0.92, 0.75 + Math.abs(diff) * 0.04);
      return {
        outcome, confidence: conf, eventType: 'soccer_match',
        reasoning: `${teamName} leads ${teamScore}-${oppScore} in ${status}. Very likely to win.`,
        keyFact: line,
      };
    }
  }
  return null;
}

async function analyzeMarket(market: MarketInfo): Promise<AIPrediction> {
  const minutesLeft = Math.round(market.hoursLeft * 60);
  const eventType   = classifyEventType(market.question);
  const accuracy    = getAccuracy(eventType);

  let searchResults = 'No search results available.';
  let espnRaw = '';
  const closeDate   = new Date(market.endDate).toUTCString();
  try {
    // Sharp, factual search — get live score or confirmed result
    const isLiveGame = /vs\.|vs |at |\bvs\b/.test(market.question);
    const searchQuery = isLiveGame
      ? `Live score result: ${market.question} today ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Who is winning or who won? Final score?`
      : `"${market.question}" result confirmed news ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Has this happened yet? What is the current status?`;
    const result = await search(searchQuery);
    searchResults = result.answer || 'No results found.';
    espnRaw = searchResults;
  } catch (e) {
    console.error('[edge-ai] search error:', (e as Error).message);
  }

  // Fast path: if ESPN gave us a score, parse it directly — no LLM needed
  const espnPred = parseESPNScore(espnRaw, market.question);
  if (espnPred) {
    console.log(`[edge-ai] ✅ ESPN direct parse: ${espnPred.outcome} @ ${(espnPred.confidence * 100).toFixed(0)}%`);
    return { ...espnPred, eventType };
  }

  const prompt = `You are a sharp prediction market trader analyzing a Polymarket question. Your goal is to find pricing errors.

QUESTION: "${market.question}"
CLOSES IN: ${minutesLeft} minutes
MARKET PRICE: YES=${( market.yesPrice * 100).toFixed(1)}¢  NO=${(market.noPrice * 100).toFixed(1)}¢
${market.description ? `RESOLUTION: ${market.description.slice(0, 300)}` : ''}

RESEARCH:
${searchResults}

TASK:
1. Find the ACTUAL current result or best evidence
2. If the outcome is already known/confirmed → bet with 85-95% confidence
3. If strong evidence exists → bet with 65-80% confidence  
4. If truly uncertain → UNCERTAIN with <60% confidence
5. Look for PRICING ERRORS: if market shows 30% but you know it's 80% likely → that's edge

Respond ONLY with this exact JSON (no markdown):
{
  "outcome": "YES" or "NO" or "UNCERTAIN",
  "confidence": 0.0 to 1.0,
  "eventType": "soccer_match|basketball_game|american_football|election|crypto_price|sports_award|weather|general",
  "reasoning": "one sentence with the KEY fact",
  "keyFact": "exact quote or data point from search that confirms your answer"
}`;

  try {
    const raw = await ask(prompt, { temperature: 0.1 });

    // 1. Regex field extraction — avoids JSON.parse failures from LLM formatting
    const outcomeM    = raw.match(/"outcome"\s*:\s*"(YES|NO|UNCERTAIN)"/i);
    const confidenceM = raw.match(/"confidence"\s*:\s*([0-9.]+)/i);
    const eventTypeM  = raw.match(/"eventType"\s*:\s*"([^"]+)"/i);
    const reasoningM  = raw.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const keyFactM    = raw.match(/"keyFact"\s*:\s*"((?:[^"\\]|\\.)*)"/i);

    if (outcomeM && confidenceM) {
      const conf = parseFloat(confidenceM[1]);
      return {
        outcome:    outcomeM[1] as 'YES' | 'NO' | 'UNCERTAIN',
        confidence: Math.min(1, Math.max(0, conf > 1 ? conf / 100 : conf)),
        eventType:  (eventTypeM?.[1] ?? eventType) as EventType,
        reasoning:  reasoningM?.[1] ?? '',
        keyFact:    keyFactM?.[1] ?? '',
      };
    }

    // 2. Fallback: try JSON.parse with cleanup
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        let jsonStr = jsonMatch[0];
        jsonStr = jsonStr.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
        jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(jsonStr);
        return {
          outcome:    (parsed.outcome === 'YES' || parsed.outcome === 'NO') ? parsed.outcome : 'UNCERTAIN',
          confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence ?? '0'))),
          eventType:  parsed.eventType ?? eventType,
          reasoning:  parsed.reasoning ?? '',
          keyFact:    parsed.keyFact ?? '',
        };
      } catch { /* fall through to prose */ }
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
        const clampedSell = Math.min(sellPrice, 0.99);  // CLOB max price is 0.99
        const profit = (clampedSell - pos.entryPrice) * pos.shares;
        const label  = pos.dryRun ? '[DRY-RUN]' : '[LIVE]';
        console.log(`[edge-ai] Closing position ${label} profit=$${profit.toFixed(2)}`);
        await tg(
          `💰 <b>Edge AI Close ${label}</b>\n` +
          `Market: ${pos.question.slice(0, 80)}\n` +
          `Entry: ${(pos.entryPrice * 100).toFixed(1)}¢ → Sell: ${(clampedSell * 100).toFixed(1)}¢\n` +
          `Profit: +$${profit.toFixed(2)}\n` +
          `AI confidence was: ${((pos.aiConfidence ?? 0) * 100).toFixed(0)}%`
        );
        if (ARMED && !pos.dryRun) {
          await placeSell({ tokenId: pos.tokenId, shares: pos.shares, price: clampedSell });
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
    `Markets 0–24h: ${fresh.length} | Positions: ${currentOpen.length}/${MAX_POSITIONS}\n` +
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

      // Use per-event-type threshold if available
      const eventThreshold = EVENT_THRESHOLDS[prediction.eventType] ?? threshold;
      if (prediction.outcome === 'UNCERTAIN' || prediction.confidence < eventThreshold) {
        console.log(`[edge-ai] Skip: confidence ${(prediction.confidence * 100).toFixed(0)}% < threshold ${(eventThreshold * 100).toFixed(0)}% (${prediction.eventType})`);
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

      // EDGE CHECK: only bet if market price is meaningfully wrong (≥5% edge)
      // If AI says YES @ 70% but market already shows 68%, edge is only 2% — not worth it
      const edge = prediction.confidence - entryPrice;
      if (Math.abs(edge) < 0.03) {
        console.log(`[edge-ai] Skip: insufficient edge ${(edge * 100).toFixed(1)}% (need ≥3%)`);
        continue;
      }

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
    console.log('[edge-ai] No markets expiring within 24h right now');
    await tg('🧠 Edge AI — no markets expiring within 24 hours this cycle');
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
