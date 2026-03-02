/**
 * Tennis Arbitrage Strategy
 *
 * Uses The Odds API (ATP/WTA) + ESPN live scores to find edges
 * on Polymarket tennis markets (Grand Slams, major tournaments).
 *
 * Two signal types:
 *  A) ODDS SIGNAL   — bookmaker implies significantly more than Polymarket
 *  B) LIVE SIGNAL   — ESPN shows set lead in final sets → near-certain winner
 *
 * Active during: Indian Wells, Miami, Roland Garros, Wimbledon, US Open
 *
 * Run: ARMED=true npx tsx src/strategies/tennis-arb.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED          = process.env.ARMED === 'true';
const MAX_POSITIONS  = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL  = 5 * 60_000;
const GAMMA_HOST     = 'https://gamma-api.polymarket.com';
const ODDS_API_KEY   = process.env.THE_ODDS_API_KEY || '1a82db670eedcd02dbe925e19b695123';
const BET_SIZE_USD   = 1;
const MIN_EDGE       = 0.07;  // 7% edge minimum

// Tennis sports keys on The Odds API — dynamically populated
// Grand Slam keys: tennis_atp_wimbledon, tennis_atp_us_open, tennis_atp_french_open, tennis_atp_aus_open
// Current tournaments are discovered dynamically
const KNOWN_TENNIS_SPORTS = [
  'tennis_atp_indian_wells', 'tennis_wta_indian_wells',
  'tennis_atp_miami_open',   'tennis_wta_miami_open',
  'tennis_atp_french_open',  'tennis_wta_french_open',
  'tennis_atp_wimbledon',    'tennis_wta_wimbledon',
  'tennis_atp_us_open',      'tennis_wta_us_open',
  'tennis_atp_australian_open', 'tennis_wta_australian_open',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlayerOdds {
  sport:      string;
  player:     string;
  opponent:   string;
  impliedProb: number;  // bookmaker implied prob for this player to win match
  startTime:  Date;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function winCurl(url: string): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '15', url],
    { encoding: 'utf8', timeout: 18000, maxBuffer: 10 * 1024 * 1024 }
  );
  return r.status === 0 && (r.stdout?.length ?? 0) > 10 ? r.stdout : null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Discover active tennis sports on Odds API ───────────────────────────────

function getActiveTennisSports(): string[] {
  const raw = winCurl(`https://api.the-odds-api.com/v4/sports?apiKey=${ODDS_API_KEY}`);
  if (!raw) return KNOWN_TENNIS_SPORTS;
  try {
    const sports = JSON.parse(raw) as any[];
    return sports
      .filter(s => s.active && s.key?.startsWith('tennis_'))
      .map(s => s.key);
  } catch {
    return KNOWN_TENNIS_SPORTS;
  }
}

// ─── Fetch tennis odds ────────────────────────────────────────────────────────

function fetchTennisOdds(activeSports: string[]): PlayerOdds[] {
  const allOdds: PlayerOdds[] = [];

  for (const sport of activeSports) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const raw = winCurl(url);
    if (!raw) continue;

    let events: any[];
    try { events = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(events) || events.length === 0) continue;

    for (const ev of events) {
      const home   = ev.home_team ?? '';
      const away   = ev.away_team ?? '';
      const start  = ev.commence_time ? new Date(ev.commence_time) : new Date();

      // Get best odds from all bookmakers
      let homeBestOdds = 0, awayBestOdds = 0;
      for (const bm of ev.bookmakers ?? []) {
        for (const market of bm.markets ?? []) {
          if (market.key !== 'h2h') continue;
          for (const outcome of market.outcomes ?? []) {
            if (outcome.name === home && outcome.price > homeBestOdds) homeBestOdds = outcome.price;
            if (outcome.name === away && outcome.price > awayBestOdds) awayBestOdds = outcome.price;
          }
        }
      }

      if (homeBestOdds > 1) {
        allOdds.push({ sport, player: home, opponent: away, impliedProb: 1 / homeBestOdds, startTime: start });
      }
      if (awayBestOdds > 1) {
        allOdds.push({ sport, player: away, opponent: home, impliedProb: 1 / awayBestOdds, startTime: start });
      }
    }
  }

  return allOdds;
}

// ─── Fetch ESPN tennis live scores ────────────────────────────────────────────

interface TennisMatch {
  player1:    string;
  player2:    string;
  sets1:      number;   // sets won by player1
  sets2:      number;
  totalSets:  number;   // best of 3 or 5
  inProgress: boolean;
  winner:     string | null;
}

function fetchESPNTennis(): TennisMatch[] {
  const matches: TennisMatch[] = [];
  for (const sport of ['atp', 'wta']) {
    const raw = winCurl(`https://site.api.espn.com/apis/site/v2/sports/tennis/${sport}/scoreboard`);
    if (!raw) continue;
    let data: any;
    try { data = JSON.parse(raw); } catch { continue; }

    for (const ev of data.events ?? []) {
      for (const comp of ev.competitions ?? []) {
        const statusName  = comp.status?.type?.name ?? '';
        const inProgress  = statusName === 'STATUS_IN_PROGRESS' || statusName.includes('PROGRESS');
        const isFinal     = statusName === 'STATUS_FINAL' || statusName.includes('FINAL');

        if (!inProgress && !isFinal) continue;

        const competitors = comp.competitors ?? [];
        if (competitors.length < 2) continue;

        const c1 = competitors[0];
        const c2 = competitors[1];
        const name1 = c1.athlete?.displayName ?? c1.athlete?.name ?? '';
        const name2 = c2.athlete?.displayName ?? c2.athlete?.name ?? '';
        if (!name1 || !name2) continue;

        // Parse set scores from linescores
        const sets1 = (c1.linescores ?? []).filter((s: any) => parseInt(s.value) > parseInt(c2.linescores?.[c1.linescores.indexOf(s)]?.value ?? '0')).length;
        const sets2 = (c2.linescores ?? []).filter((s: any, i: number) => parseInt(s.value) > parseInt(c1.linescores?.[i]?.value ?? '0')).length;
        const totalSets = parseInt(comp.status?.period?.toString() ?? '1');

        let winner: string | null = null;
        if (isFinal) {
          winner = c1.winner ? name1 : c2.winner ? name2 : sets1 > sets2 ? name1 : name2;
        }

        matches.push({ player1: name1, player2: name2, sets1, sets2, totalSets, inProgress, winner });
      }
    }
  }
  return matches;
}

// ─── Find Polymarket tennis markets ──────────────────────────────────────────

async function fetchTennisPolyMarkets(): Promise<any[]> {
  // Tennis markets use tournament names and "will X win" format
  const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
  if (!raw) return [];
  const all = JSON.parse(raw) as any[];
  return all.filter(m => {
    const q = (m.question ?? '').toLowerCase();
    return /tennis|wimbledon|us open|french open|roland garros|australian open|indian wells|miami open|atp|wta/i.test(q) ||
           /will \w[\w\s]+ win the.*open/i.test(q);
  });
}

// ─── Match player to Polymarket question ─────────────────────────────────────

function playerMatchesMarket(playerName: string, question: string): boolean {
  const q   = normalize(question);
  const pn  = normalize(playerName);
  if (q.includes(pn)) return true;
  // Last name match (strict word boundary)
  const lastName = pn.split(' ').pop() ?? '';
  if (lastName.length < 4) return false;
  const idx = q.indexOf(lastName);
  if (idx === -1) return false;
  const before = idx === 0 || /\s/.test(q[idx - 1]);
  const after  = idx + lastName.length >= q.length || /\s/.test(q[idx + lastName.length]);
  return before && after;
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const open = getOpenPositions().filter(p => p.strategy === 'tennis-arb');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[tennis] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  // Discover active tennis sports on Odds API
  const activeTennisSports = getActiveTennisSports();
  console.log(`[tennis] Active tennis markets on Odds API: ${activeTennisSports.join(', ')}`);

  if (activeTennisSports.length === 0) {
    console.log('[tennis] No active tennis tournament — nothing to trade');
    return;
  }

  // Fetch tennis odds
  const odds = fetchTennisOdds(activeTennisSports);
  console.log(`[tennis] ${odds.length} player odds fetched`);

  // Fetch ESPN live matches
  const espnMatches = fetchESPNTennis();
  console.log(`[tennis] ${espnMatches.length} ESPN tennis matches`);

  // Fetch Polymarket tennis markets
  const polyMarkets = await fetchTennisPolyMarkets();
  console.log(`[tennis] ${polyMarkets.length} Polymarket tennis markets`);

  if (polyMarkets.length === 0) {
    console.log('[tennis] No Polymarket tennis markets — waiting for Grand Slam season');
    return;
  }

  if (ARMED) {
    const usdc = await getUsdcBalance();
    if (usdc < 1) { console.log('[tennis] Insufficient balance'); return; }
  }

  const heldIds = open.map(p => p.conditionId);
  const signals: any[] = [];

  // ODDS SIGNALS from Odds API
  for (const playerOdds of odds) {
    for (const market of polyMarkets) {
      const q = market.question ?? '';
      if (!playerMatchesMarket(playerOdds.player, q)) continue;
      if (!/will .+ win/i.test(q)) continue;

      const prices = JSON.parse(market.outcomePrices ?? '[]');
      const yesPrice = parseFloat(prices[0]);
      if (isNaN(yesPrice) || yesPrice <= 0) continue;

      const liq = parseFloat(market.liquidityNum ?? market.liquidity ?? '0');
      if (liq < 100) continue;

      const edge = playerOdds.impliedProb - yesPrice;
      if (edge < MIN_EDGE) continue;

      const tokens  = JSON.parse(market.tokens ?? market.clobTokenIds ?? '[]');
      signals.push({
        type: 'ODDS',
        player: playerOdds.player,
        market,
        yesPrice,
        confidence: playerOdds.impliedProb,
        edge,
        tokenId: tokens[0] ?? '',
        reason: `Bookmaker ${(playerOdds.impliedProb*100).toFixed(0)}% vs Poly ${(yesPrice*100).toFixed(0)}%`,
      });
      break;
    }
  }

  // LIVE SIGNALS from ESPN (player winning convincingly in final set)
  for (const match of espnMatches) {
    const isMatchPoint = match.inProgress && (
      (match.sets1 === 2 && match.totalSets >= 2) ||  // 2 sets up in best-of-3
      (match.sets1 === 3 && match.totalSets >= 3)     // 3 sets up in best-of-5
    );
    const isFinished = match.winner != null;

    if (!isMatchPoint && !isFinished) continue;

    const leader = isFinished ? match.winner! : match.player1;
    const confidence = isFinished ? 0.96 : 0.90;

    for (const market of polyMarkets) {
      const q = market.question ?? '';
      if (!playerMatchesMarket(leader, q)) continue;
      if (!/will .+ win/i.test(q)) continue;

      const prices = JSON.parse(market.outcomePrices ?? '[]');
      const yesPrice = parseFloat(prices[0]);
      if (isNaN(yesPrice) || yesPrice <= 0) continue;

      const liq = parseFloat(market.liquidityNum ?? market.liquidity ?? '0');
      if (liq < 100) continue;

      const edge = confidence - yesPrice;
      if (edge < MIN_EDGE) continue;

      const tokens = JSON.parse(market.tokens ?? market.clobTokenIds ?? '[]');
      signals.push({
        type: isFinished ? 'FINAL' : 'LIVE',
        player: leader,
        market,
        yesPrice,
        confidence,
        edge,
        tokenId: tokens[0] ?? '',
        reason: isFinished
          ? `Match FINAL: ${match.player1} ${match.sets1}-${match.sets2} ${match.player2}`
          : `Leading ${match.sets1}-${match.sets2} in sets, final set`,
      });
      break;
    }
  }

  signals.sort((a, b) => b.edge - a.edge);
  console.log(`[tennis] ${signals.length} signals found`);

  for (const sig of signals.slice(0, MAX_POSITIONS - open.length)) {
    if (heldIds.includes(sig.market.conditionId)) continue;

    console.log(`\n[tennis] 🎾 ${sig.type}: ${sig.player}`);
    console.log(`  ${sig.reason}`);
    console.log(`  Market: ${sig.market.question?.slice(0, 80)}`);
    console.log(`  Edge: ${(sig.edge*100).toFixed(1)}% | Bet: $${BET_SIZE_USD}`);

    if (!ARMED) {
      console.log(`  [DRY RUN] Would buy YES @ ${sig.yesPrice.toFixed(2)}`);
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) { console.log('[tennis] Market not accepting orders'); continue; }

      const shares = Math.floor(BET_SIZE_USD / sig.yesPrice);
      if (shares < 5) { console.log('[tennis] Too few shares, skip'); continue; }

      const orderId = await placeBuy({ tokenId: sig.tokenId, price: sig.yesPrice, size: BET_SIZE_USD, side: 'YES' });
      addPosition({ conditionId: sig.market.conditionId, question: sig.market.question, side: 'YES', entryPrice: sig.yesPrice, shares, cost: BET_SIZE_USD, strategy: 'tennis-arb' });

      const msg = `🎾 Tennis ${sig.type}: ${sig.player} | ${sig.reason} | $${BET_SIZE_USD} edge ${(sig.edge*100).toFixed(1)}%`;
      await tg(msg);
      console.log('[tennis] ✅', msg);
    } catch (e: any) {
      console.log('[tennis] ❌ Error:', e.message);
    }
  }
}

// ─── Export + standalone ──────────────────────────────────────────────────────

export async function runTennisArb(): Promise<void> {
  const monitor = process.argv.includes('--monitor');
  console.log(`[tennis] Starting tennis arb | ARMED=${ARMED} | monitor=${monitor}`);
  await runCycle();
  if (monitor) {
    setInterval(runCycle, SCAN_INTERVAL);
    console.log(`[tennis] Scanning every ${SCAN_INTERVAL / 60000} min`);
    await new Promise(() => {});
  }
}

if (process.argv[1]?.endsWith('tennis-arb.ts') || process.argv[1]?.endsWith('tennis-arb.js')) {
  runTennisArb().catch(console.error);
}
