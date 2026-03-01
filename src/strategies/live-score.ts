/**
 * Live Score Edge Strategy
 *
 * Fetches real-time ESPN scores for soccer and NHL hockey.
 * When a team is winning by 2+ goals with <20 min left, finds the matching
 * Polymarket "Will X win" market and buys YES if price is lagging.
 *
 * Run: ARMED=true npx tsx src/strategies/live-score.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 3 * 60_000; // 3 min
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';

interface LiveGame {
  homeTeam:    string;
  awayTeam:    string;
  homeScore:   number;
  awayScore:   number;
  sport:       string;
  minutesLeft: number; // approximate minutes remaining
  status:      string;
}

function fuzzyMatch(teamA: string, teamB: string): boolean {
  const norm = (s: string) => s.toLowerCase()
    .replace(/\bfc\b|\bsc\b|\bac\b|\baf\b|\bcf\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  const a = norm(teamA);
  const b = norm(teamB);
  if (a === b) return true;
  // Check if either contains the other (handles "Man City" vs "Manchester City")
  if (a.length > 4 && b.includes(a)) return true;
  if (b.length > 4 && a.includes(b)) return true;
  // First word match (e.g. "Liverpool" in "Liverpool FC")
  const aWords = a.split(' ').filter(w => w.length > 3);
  const bWords = b.split(' ').filter(w => w.length > 3);
  return aWords.some(w => bWords.includes(w));
}

async function fetchESPNScores(sport: 'soccer' | 'nhl'): Promise<LiveGame[]> {
  const url = sport === 'soccer'
    ? 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard'
    : 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';

  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`ESPN ${sport} ${r.status}`);
  const data = await r.json() as any;

  const games: LiveGame[] = [];
  for (const event of data.events ?? []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const statusType = comp.status?.type?.name ?? '';
    const isLive = statusType === 'STATUS_IN_PROGRESS' || statusType === 'STATUS_SECOND_PERIOD' ||
                   statusType === 'STATUS_THIRD_PERIOD' || statusType === 'STATUS_FIRST_PERIOD' ||
                   statusType === 'STATUS_HALFTIME' || statusType.includes('PROGRESS');
    if (!isLive) continue;

    const competitors = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === 'home');
    const away = competitors.find((c: any) => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeScore = parseInt(home.score ?? '0');
    const awayScore = parseInt(away.score ?? '0');

    // Parse minutes left from clock display
    const clock = comp.status?.displayClock ?? '';
    const period = comp.status?.period ?? 1;
    let minutesLeft = 90; // default soccer
    if (sport === 'soccer') {
      const clockMin = parseInt(clock);
      minutesLeft = isNaN(clockMin) ? 45 : Math.max(0, 90 - clockMin);
    } else {
      // NHL: 3 periods × 20 min
      const [mm] = clock.split(':').map(Number);
      minutesLeft = !isNaN(mm) ? mm + (3 - Math.min(period, 3)) * 20 : 30;
    }

    games.push({
      homeTeam:  home.team?.displayName ?? home.team?.name ?? '',
      awayTeam:  away.team?.displayName ?? away.team?.name ?? '',
      homeScore, awayScore, sport,
      minutesLeft,
      status: comp.status?.type?.shortDetail ?? '',
    });
  }
  return games;
}

async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ═══ Live Score Cycle ═══`);

  const open = getOpenPositions().filter(p => p.strategy === 'live-score');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[live] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  // Fetch live games
  let liveGames: LiveGame[] = [];
  try {
    const [soccer, nhl] = await Promise.allSettled([
      fetchESPNScores('soccer'),
      fetchESPNScores('nhl'),
    ]);
    if (soccer.status === 'fulfilled') liveGames.push(...soccer.value);
    if (nhl.status === 'fulfilled') liveGames.push(...nhl.value);
    console.log(`[live] ${liveGames.length} live games (soccer + NHL)`);
  } catch (e: any) {
    console.log('[live] Score fetch error:', e.message);
    return;
  }

  if (liveGames.length === 0) {
    console.log('[live] No live games right now');
    return;
  }

  // Filter for strong edges: 2+ goal lead with <20 min left
  const edges = liveGames.filter(g => {
    const diff = Math.abs(g.homeScore - g.awayScore);
    return diff >= 2 && g.minutesLeft <= 20;
  });

  console.log(`[live] ${edges.length} games with strong edge (2+ lead, <20min left)`);

  if (edges.length === 0) {
    // Log close games for awareness
    for (const g of liveGames.slice(0, 5)) {
      console.log(`[live]   ${g.awayTeam} ${g.awayScore}-${g.homeScore} ${g.homeTeam} (${g.minutesLeft}min left)`);
    }
    return;
  }

  const usdc = ARMED ? await getUsdcBalance() : 20;
  if (ARMED && usdc < 1) { console.log('[live] Insufficient balance'); return; }

  // Fetch Polymarket markets for matching
  let allMarkets: any[] = [];
  try {
    const now = Date.now();
    const r = await fetch(`${GAMMA_HOST}/markets?limit=300&active=true&closed=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const all = await r.json() as any[];
    allMarkets = all.filter(m => {
      const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
      const hoursLeft = (endMs - now) / 3_600_000;
      return hoursLeft > 0 && hoursLeft < 6; // only markets closing soon
    });
  } catch (e: any) {
    console.log('[live] Market fetch error:', e.message);
    return;
  }

  const heldIds = open.map(p => p.id);
  let bought = 0;

  for (const game of edges) {
    if (open.length + bought >= MAX_POSITIONS) break;

    const leader = game.homeScore > game.awayScore ? game.homeTeam : game.awayTeam;
    const diff = Math.abs(game.homeScore - game.awayScore);
    // Implied win probability based on score+time
    const impliedProb = Math.min(0.97, 0.80 + (diff - 2) * 0.05 + (20 - game.minutesLeft) * 0.005);

    console.log(`\n[live] 🔥 Edge: ${game.awayTeam} ${game.awayScore}-${game.homeScore} ${game.homeTeam}`);
    console.log(`[live]   Leader: ${leader} | ${game.minutesLeft}min left | Implied: ${(impliedProb * 100).toFixed(0)}%`);

    // Find matching Polymarket "Will X win" market
    const match = allMarkets.find(m => {
      const q = m.question ?? '';
      if (!/win/i.test(q)) return false;
      return fuzzyMatch(leader, q);
    });

    if (!match) {
      console.log(`[live]   No matching Polymarket found for ${leader}`);
      continue;
    }
    if (heldIds.includes(match.conditionId)) continue;

    const prices = JSON.parse(match.outcomePrices ?? '[0.5,0.5]');
    const yesPrice = parseFloat(prices[0]);

    // Only bet if Polymarket price is lagging (YES < implied prob - 8%)
    const edge = impliedProb - yesPrice;
    if (edge < 0.08) {
      console.log(`[live]   Market already priced in (${(yesPrice * 100).toFixed(0)}¢ vs ${(impliedProb * 100).toFixed(0)}% implied, edge=${(edge * 100).toFixed(1)}%)`);
      continue;
    }

    console.log(`[live]   ✅ Market: ${match.question.slice(0, 70)}`);
    console.log(`[live]   YES=${(yesPrice * 100).toFixed(0)}¢ vs implied ${(impliedProb * 100).toFixed(0)}% → edge=${(edge * 100).toFixed(1)}%`);

    // Get token ID from CLOB
    let tokenId: string;
    let entryPrice: number;
    try {
      const clob: any = await getClobMarket(match.conditionId);
      if (!clob.accepting_orders) continue;
      const tokens: any[] = clob.tokens ?? [];
      const yesToken = tokens.find(t => t.outcome?.toUpperCase() === 'YES') ?? tokens[0];
      if (!yesToken?.token_id) continue;
      tokenId = yesToken.token_id;
      entryPrice = parseFloat(yesToken.price ?? yesPrice.toString());
    } catch (e: any) {
      console.log('[live] CLOB error:', e.message);
      continue;
    }

    const betSize = Math.min(2.00, usdc * 0.1);
    const msg = `⚽ <b>Live Score Edge ${ARMED ? '[LIVE]' : '[DRY-RUN]'}</b>\n` +
      `${game.awayTeam} ${game.awayScore}-${game.homeScore} ${game.homeTeam}\n` +
      `${game.minutesLeft}min left | Leader: <b>${leader}</b>\n` +
      `Polymarket YES: ${(yesPrice * 100).toFixed(0)}¢ vs implied ${(impliedProb * 100).toFixed(0)}%\n` +
      `Edge: +${(edge * 100).toFixed(1)}% | Bet: $${betSize.toFixed(2)}`;

    await tg(msg);

    if (ARMED) {
      try {
        const { orderId, shares } = await placeBuy({ tokenId, conditionId: match.conditionId, price: entryPrice, usdcAmount: betSize });
        addPosition({
          id: match.conditionId, tokenId, question: match.question,
          side: 'YES', strategy: 'live-score',
          shares, entryPrice, usdcSpent: betSize,
          entryTime: Date.now(), orderId, status: 'open', dryRun: false,
        });
        await tg(`✅ Live score order: ${orderId}`);
        bought++;
      } catch (e: any) {
        await tg(`❌ Live score buy failed: ${e.message}`);
      }
    } else {
      bought++;
    }
  }
}

export async function runLiveScore(): Promise<void> {
  const mode = process.argv.find(a => a === '--monitor');
  if (mode) {
    console.log(`🚀 Live Score started | ARMED=${ARMED}`);
    await tg(`⚽ Live Score started | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`);
    await runCycle();
    setInterval(() => runCycle().catch(console.error), SCAN_INTERVAL);
    await new Promise(() => {});
  } else {
    await runCycle();
  }
}

if (process.argv[1]?.endsWith('live-score.ts') || process.argv[1]?.endsWith('live-score.js')) {
  runLiveScore().catch(console.error);
}
