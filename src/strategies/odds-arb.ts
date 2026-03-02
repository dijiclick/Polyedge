/**
 * Odds Arbitrage Strategy
 *
 * Fetches real bookmaker odds from The Odds API and compares them to
 * Polymarket prices. When bookmakers imply a significantly different
 * probability than Polymarket shows, we have a real edge.
 *
 * Example: Bookmakers say Bucks win at 65% implied prob, Polymarket shows 56% → buy YES
 *
 * Run: ARMED=true npx tsx src/strategies/odds-arb.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 5 * 60_000; // 5 min
const ODDS_API_KEY  = process.env.THE_ODDS_API_KEY || '1a82db670eedcd02dbe925e19b695123';
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';
const MIN_EDGE      = 0.07; // minimum 7% edge vs bookmakers

const SPORTS = [
  { key: 'basketball_nba',           label: 'NBA' },
  { key: 'icehockey_nhl',            label: 'NHL' },
  { key: 'soccer_epl',               label: 'EPL' },
  { key: 'soccer_spain_la_liga',     label: 'La Liga' },
  { key: 'soccer_italy_serie_a',     label: 'Serie A' },
  { key: 'soccer_germany_bundesliga',label: 'Bundesliga' },
  { key: 'soccer_france_ligue_one',  label: 'Ligue 1' },
  { key: 'americanfootball_nfl',     label: 'NFL' },
  { key: 'baseball_mlb',             label: 'MLB' },
  { key: 'tennis_atp',               label: 'ATP Tennis' },
  { key: 'tennis_wta',               label: 'WTA Tennis' },
  { key: 'basketball_euroleague',    label: 'Euroleague' },
  { key: 'soccer_uefa_champs_league',label: 'Champions League' },
  { key: 'soccer_uefa_europa_league',label: 'Europa League' },
  { key: 'soccer_usa_mls',           label: 'MLS' },
];

interface BookmakerOdds {
  sport:    string;
  homeTeam: string;
  awayTeam: string;
  homeProb: number; // implied probability
  awayProb: number;
  startTime: Date;
}

// Use Windows curl.exe to bypass WSL TLS issues
function winCurl(url: string): string | null {
  const result = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '10', url],
    { encoding: 'utf8', timeout: 12000 }
  );
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}

async function fetchOdds(): Promise<BookmakerOdds[]> {
  const games: BookmakerOdds[] = [];
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);

  for (const sport of SPORTS) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
    const raw = winCurl(url);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw) as any[];
      if (!Array.isArray(data)) continue;

      for (const g of data) {
        const startTime = new Date(g.commence_time);
        // Only games starting in the next 24h
        if (startTime < now || startTime > tomorrow) continue;

        // Get best odds across all bookmakers
        const oddsMap: Record<string, number[]> = {};
        for (const bm of g.bookmakers ?? []) {
          for (const market of bm.markets ?? []) {
            if (market.key !== 'h2h') continue;
            for (const outcome of market.outcomes ?? []) {
              if (!oddsMap[outcome.name]) oddsMap[outcome.name] = [];
              oddsMap[outcome.name].push(outcome.price);
            }
          }
        }

        const homeOdds = oddsMap[g.home_team] ? Math.max(...oddsMap[g.home_team]) : 0;
        const awayOdds = oddsMap[g.away_team] ? Math.max(...oddsMap[g.away_team]) : 0;
        if (!homeOdds || !awayOdds) continue;

        // Implied probability = 1 / decimal odds (normalize to remove vig)
        const homeRaw = 1 / homeOdds;
        const awayRaw = 1 / awayOdds;
        const total   = homeRaw + awayRaw;
        const homeProb = homeRaw / total;
        const awayProb = awayRaw / total;

        games.push({ sport: sport.label, homeTeam: g.home_team, awayTeam: g.away_team, homeProb, awayProb, startTime });
      }
    } catch { continue; }
  }

  return games;
}

function fuzzyTeamMatch(teamName: string, question: string): boolean {
  const q = question.toLowerCase();
  const t = teamName.toLowerCase();

  // Direct name contains
  if (q.includes(t)) return true;

  // Try first significant word (length > 4)
  const words = t.split(' ').filter(w => w.length > 4);
  if (words.some(w => q.includes(w))) return true;

  // Common abbreviations
  const abbrevs: Record<string, string[]> = {
    'los angeles lakers': ['lakers', 'la lakers'],
    'los angeles clippers': ['clippers', 'la clippers'],
    'golden state warriors': ['warriors', 'golden state'],
    'new york knicks': ['knicks'],
    'boston celtics': ['celtics'],
    'milwaukee bucks': ['bucks'],
    'chicago bulls': ['bulls'],
    'toronto raptors': ['raptors'],
    'philadelphia 76ers': ['sixers', '76ers'],
  };
  const alts = abbrevs[t] ?? [];
  return alts.some(a => q.includes(a));
}

async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ═══ Odds Arb Cycle ═══`);

  const open = getOpenPositions().filter(p => p.strategy === 'odds-arb');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[odds-arb] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  // Fetch bookmaker odds
  const games = await fetchOdds();
  console.log(`[odds-arb] ${games.length} upcoming games with odds`);

  if (games.length === 0) {
    console.log('[odds-arb] No games available from Odds API');
    return;
  }

  const usdc = ARMED ? await getUsdcBalance() : 20;
  if (ARMED && usdc < 1) { console.log('[odds-arb] Insufficient balance'); return; }

  // Fetch Polymarket markets closing in <48h (use winCurl to bypass WSL TLS)
  let allMarkets: any[] = [];
  try {
    const now = Date.now();
    const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
    if (!raw) { console.log('[odds-arb] Gamma API unreachable'); return; }
    const all = JSON.parse(raw) as any[];
    allMarkets = all.filter(m => {
      const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
      const hoursLeft = (endMs - now) / 3_600_000;
      return hoursLeft > 0 && hoursLeft < 48;
    });
    console.log(`[odds-arb] ${allMarkets.length} Polymarket markets closing <48h`);
  } catch (e: any) {
    console.log('[odds-arb] Market fetch error:', e.message);
    return;
  }

  const heldIds = open.map(p => p.id);
  let bought = 0;

  for (const game of games) {
    if (open.length + bought >= MAX_POSITIONS) break;

    // Find matching "Will X win" market
    for (const [teamName, bookProb] of [[game.homeTeam, game.homeProb], [game.awayTeam, game.awayProb]] as [string, number][]) {
      const market = allMarkets.find(m => {
        const q = m.question ?? '';
        return /win/i.test(q) && fuzzyTeamMatch(teamName, q);
      });
      if (!market) continue;
      if (heldIds.includes(market.conditionId)) continue;

      const prices = JSON.parse(market.outcomePrices ?? '[0.5,0.5]');
      const polyYesPrice = parseFloat(prices[0]);

      const edge = bookProb - polyYesPrice;

      if (Math.abs(edge) < MIN_EDGE) {
        console.log(`[odds-arb] ${teamName}: book=${(bookProb*100).toFixed(0)}% poly=${(polyYesPrice*100).toFixed(0)}% edge=${(edge*100).toFixed(1)}% — skip`);
        continue;
      }

      // Determine bet direction
      const buySide  = edge > 0 ? 'YES' : 'NO';
      const entryPct = edge > 0 ? polyYesPrice : (1 - polyYesPrice);

      console.log(`\n[odds-arb] 🎯 EDGE: ${teamName}`);
      console.log(`  Sport: ${game.sport} | ${game.awayTeam} @ ${game.homeTeam}`);
      console.log(`  Book implied: ${(bookProb*100).toFixed(1)}% | Poly YES: ${(polyYesPrice*100).toFixed(1)}%`);
      console.log(`  Edge: ${edge > 0 ? '+' : ''}${(edge*100).toFixed(1)}% → BUY ${buySide}`);
      console.log(`  Market: ${market.question?.slice(0, 70)}`);
      console.log(`  Starts: ${game.startTime.toUTCString()}`);

      // Get token from CLOB
      let tokenId: string;
      let clEntry: number;
      try {
        const clob: any = await getClobMarket(market.conditionId);
        if (!clob.accepting_orders) continue;
        const tokens: any[] = clob.tokens ?? [];
        const token = buySide === 'YES'
          ? tokens.find(t => t.outcome?.toUpperCase() === 'YES') ?? tokens[0]
          : tokens.find(t => t.outcome?.toUpperCase() === 'NO') ?? tokens[1];
        if (!token?.token_id) continue;
        tokenId = token.token_id;
        clEntry = parseFloat(token.price ?? String(entryPct));
      } catch (e: any) {
        console.log('[odds-arb] CLOB error:', e.message);
        continue;
      }

      // Kelly-ish bet: edge * bankroll fraction, capped at $3
      const kellyFrac = Math.min(0.15, Math.abs(edge));
      const betSize = Math.min(1.00, usdc * kellyFrac);

      const msg =
        `📊 <b>Odds Arb ${ARMED ? '[LIVE]' : '[DRY]'}</b>\n` +
        `${market.question?.slice(0, 80)}\n` +
        `Book: ${(bookProb*100).toFixed(1)}% | Poly: ${(polyYesPrice*100).toFixed(1)}%\n` +
        `Edge: <b>+${(Math.abs(edge)*100).toFixed(1)}%</b> → BUY ${buySide}\n` +
        `Bet: $${betSize.toFixed(2)} @ ${(clEntry*100).toFixed(1)}¢`;

      await tg(msg);

      if (ARMED) {
        try {
          const { orderId, shares } = await placeBuy({ tokenId, conditionId: market.conditionId, price: clEntry, usdcAmount: betSize });
          addPosition({
            id: market.conditionId, tokenId, question: market.question,
            side: buySide, strategy: 'odds-arb',
            shares, entryPrice: clEntry, usdcSpent: betSize,
            entryTime: Date.now(), orderId, status: 'open', dryRun: false,
          });
          await tg(`✅ Odds arb order: ${orderId}`);
          bought++;
        } catch (e: any) {
          await tg(`❌ Odds arb failed: ${e.message}`);
        }
      } else {
        bought++;
      }
      break; // one bet per game
    }
  }

  if (bought === 0) console.log('[odds-arb] No edges found this cycle');
}

export async function runOddsArb(): Promise<void> {
  const mode = process.argv.find(a => a === '--monitor');
  if (mode) {
    console.log(`🚀 Odds Arb started | ARMED=${ARMED}`);
    await tg(`📊 Odds Arb started | ${ARMED ? '🔴 LIVE' : '🟡 DRY-RUN'}`);
    await runCycle();
    setInterval(() => runCycle().catch(console.error), SCAN_INTERVAL);
    await new Promise(() => {});
  } else {
    await runCycle();
  }
}

if (process.argv[1]?.endsWith('odds-arb.ts') || process.argv[1]?.endsWith('odds-arb.js')) {
  runOddsArb().catch(console.error);
}
