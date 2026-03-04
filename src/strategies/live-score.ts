/**
 * Live Score Edge Strategy
 *
 * Fetches real-time ESPN scores for soccer, NHL, NBA, NFL, MLB.
 * When a team is winning convincingly near the end, finds matching
 * Polymarket "Will X win" markets and buys YES if price is lagging.
 *
 * Run: ARMED=true npx tsx src/strategies/live-score.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

function winCurl(url: string): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '15', url],
    { encoding: 'utf8', timeout: 18000, maxBuffer: 5 * 1024 * 1024 }
  );
  return r.status === 0 && (r.stdout?.length ?? 0) > 10 ? r.stdout : null;
}

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

type ESPNSport = 'soccer' | 'nhl' | 'nba' | 'nfl' | 'mlb';

const ESPN_URLS: Record<ESPNSport, string> = {
  soccer: 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard',
  nhl:    'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  nba:    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  nfl:    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  mlb:    'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
};

// Min lead to trigger edge signal, per sport
const MIN_LEAD: Record<ESPNSport, number> = {
  soccer: 2,   // 2+ goals
  nhl:    2,   // 2+ goals
  nba:    15,  // 15+ points (NBA scores are high)
  nfl:    14,  // 14+ points (2 scores)
  mlb:    3,   // 3+ runs
};

// Max minutes left to trigger signal, per sport (base value — extended by lead size)
const MAX_MIN_LEFT: Record<ESPNSport, number> = {
  soccer: 20,
  nhl:    20,  // full 3rd period — 2-goal lead entering 3rd wins ~92%
  nba:    8,   // last 8 min of 4th quarter
  nfl:    8,   // last 8 min of 4th quarter
  mlb:    6,   // last 2 innings (rough equiv)
};

function minutesLeftForSport(sport: ESPNSport, clock: string, period: number): number {
  const parts = clock.split(':').map(Number);
  const mm = parts[0] ?? 0;
  switch (sport) {
    case 'soccer': {
      const clockMin = parseInt(clock);
      return isNaN(clockMin) ? 45 : Math.max(0, 90 - clockMin);
    }
    case 'nhl': {
      // 3 periods × 20 min
      return !isNaN(mm) ? mm + (3 - Math.min(period, 3)) * 20 : 30;
    }
    case 'nba': {
      // 4 quarters × 12 min
      return !isNaN(mm) ? mm + (4 - Math.min(period, 4)) * 12 : 24;
    }
    case 'nfl': {
      // 4 quarters × 15 min
      return !isNaN(mm) ? mm + (4 - Math.min(period, 4)) * 15 : 30;
    }
    case 'mlb': {
      // innings: period = inning; assume ~3 min per half-inning remaining
      return Math.max(0, (9 - period) * 6);
    }
    default: return 30;
  }
}

async function fetchESPNScores(sport: ESPNSport): Promise<LiveGame[]> {
  const url = ESPN_URLS[sport];
  const raw = winCurl(url);
  if (!raw) throw new Error(`ESPN ${sport} fetch failed`);
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error(`ESPN ${sport} JSON parse failed`); }

  const games: LiveGame[] = [];
  for (const event of data.events ?? []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const statusType = comp.status?.type?.name ?? '';
    const isLive = statusType === 'STATUS_IN_PROGRESS'
      || statusType.includes('PROGRESS')
      || ['STATUS_SECOND_PERIOD','STATUS_THIRD_PERIOD','STATUS_FIRST_PERIOD',
          'STATUS_FOURTH_PERIOD','STATUS_HALFTIME','STATUS_END_PERIOD',
          'STATUS_MIDDLE_INNING','STATUS_END_OF_INNING'].includes(statusType);
    if (!isLive) continue;

    const competitors = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === 'home');
    const away = competitors.find((c: any) => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeScore = parseInt(home.score ?? '0');
    const awayScore = parseInt(away.score ?? '0');
    const clock     = comp.status?.displayClock ?? '';
    const period    = comp.status?.period ?? 1;
    const minutesLeft = minutesLeftForSport(sport, clock, period);

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

  // Fetch live games from all ESPN sports
  let liveGames: LiveGame[] = [];
  try {
    const results = await Promise.allSettled([
      fetchESPNScores('soccer'),
      fetchESPNScores('nhl'),
      fetchESPNScores('nba'),
      fetchESPNScores('nfl'),
      fetchESPNScores('mlb'),
    ]);
    const labels = ['soccer','nhl','nba','nfl','mlb'];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        liveGames.push(...res.value);
        if (res.value.length > 0) console.log(`[live] ${labels[i]}: ${res.value.length} live`);
      } else {
        console.log(`[live] ${labels[i]} fetch failed: ${(res as any).reason?.message}`);
      }
    }
    console.log(`[live] Total: ${liveGames.length} live games`);
  } catch (e: any) {
    console.log('[live] Score fetch error:', e.message);
    return;
  }

  if (liveGames.length === 0) {
    console.log('[live] No live games right now');
    return;
  }

  // Filter for strong edges: sport-specific lead + time thresholds
  // Bigger leads get wider time windows (e.g. 5-goal NHL lead → 35 min window)
  const edges = liveGames.filter(g => {
    const sport = g.sport as ESPNSport;
    const diff  = Math.abs(g.homeScore - g.awayScore);
    const minLead = MIN_LEAD[sport] ?? 2;
    if (diff < minLead) return false;
    const baseMax = MAX_MIN_LEFT[sport] ?? 20;
    const extraFactor = (diff / minLead) - 1; // 0 at min lead, 1 at 2x min, etc.
    const adjustedMax = Math.round(baseMax * (1 + extraFactor * 0.5));
    return g.minutesLeft <= adjustedMax;
  });

  console.log(`[live] ${edges.length} games with strong edge`);

  if (edges.length === 0) {
    // Log close games with actual thresholds for debugging
    for (const g of liveGames.slice(0, 5)) {
      const sport = g.sport as ESPNSport;
      const diff = Math.abs(g.homeScore - g.awayScore);
      const minLead = MIN_LEAD[sport] ?? 2;
      const baseMax = MAX_MIN_LEFT[sport] ?? 20;
      const extraFactor = diff >= minLead ? (diff / minLead) - 1 : 0;
      const adjustedMax = Math.round(baseMax * (1 + extraFactor * 0.5));
      const leadOk = diff >= minLead ? '✓' : '✗';
      const timeOk = g.minutesLeft <= adjustedMax ? '✓' : '✗';
      console.log(`[live]   ${g.awayTeam} ${g.awayScore}-${g.homeScore} ${g.homeTeam} (${g.minutesLeft}min left) lead${leadOk} need≥${minLead} time${timeOk} need≤${adjustedMax}min`);
    }
    return;
  }

  const usdc = ARMED ? await getUsdcBalance() : 20;
  if (ARMED && usdc < 1) { console.log('[live] Insufficient balance'); return; }

  // Fetch Polymarket markets for matching
  let allMarkets: any[] = [];
  try {
    const now = Date.now();
    const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
    if (!raw) throw new Error('empty response');
    const all = JSON.parse(raw) as any[];
    allMarkets = all.filter(m => {
      const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
      const hoursLeft = (endMs - now) / 3_600_000;
      return hoursLeft > 0 && hoursLeft < 12; // 12h window — catch game markets across timezones
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
    // Sport-aware implied probability: soccer/hockey use goal margin, basketball uses pts
    const sport = game.sport as ESPNSport;
    const maxLeft = MAX_MIN_LEFT[sport] ?? 20;
    const minLead = MIN_LEAD[sport] ?? 2;
    const normalizedLead = (diff - minLead) / minLead;          // 0 = just enough, 1 = double min
    const timeUrgency    = (maxLeft - game.minutesLeft) / maxLeft; // 0 = just started window, 1 = no time left
    const impliedProb = Math.min(0.97, 0.82 + normalizedLead * 0.06 + timeUrgency * 0.08);

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

    const betSize = Math.min(1.00, usdc * 0.1);
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
