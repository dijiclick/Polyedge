/**
 * Kambi Soccer Live Arbitrage
 *
 * Fetches live soccer games from Kambi's public API (Unibet-powered).
 * For each LIVE game, compares the current score + bookmaker odds to
 * find Polymarket markets where the crowd hasn't caught up yet.
 *
 * Two signal types:
 *  A) SCORE SIGNAL   — team leads by 2+ goals in 60+ min → buy YES on "will X win"
 *  B) ODDS SIGNAL    — bookmaker implies >70% for an outcome, Polymarket shows <60%
 *
 * Run (dry):  npx tsx src/strategies/kambi-soccer.ts
 * Run (live): ARMED=true npx tsx src/strategies/kambi-soccer.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 3 * 60_000;          // 3 min — live games move fast
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';

// Kambi: ubse = Unibet Sweden (public, no auth needed)
const KAMBI_URL =
  'https://eu-offering-api.kambicdn.com/offering/v2018/ubse/listView/football.json' +
  '?lang=en_GB&market=SE&client_id=2&channel_id=1&ncid=1&useCombined=true&startIndex=0&stopIndex=500';

const MIN_SCORE_EDGE   = 0.08;   // bookmaker must imply 8%+ more than Polymarket
const MIN_LEAD_GOALS   = 2;      // score signal: lead by this many goals
const MIN_MINUTE_SCORE = 60;     // score signal: only after 60th minute
const MIN_MINUTE_ODDS  = 45;     // odds signal: only after halftime
const BET_SIZE_USD     = 1;      // per trade

// ─── Types ───────────────────────────────────────────────────────────────────

interface LiveGame {
  eventId:   number;
  homeName:  string;
  awayName:  string;
  homeScore: number;
  awayScore: number;
  minute:    number;
  period:    string;    // '1st half' | '2nd half' | 'extra time'
  group:     string;    // league name
  homeOdds:  number;    // decimal odds
  drawOdds:  number;
  awayOdds:  number;
  homeProb:  number;    // implied probability (no vig removed for simplicity)
  awayProb:  number;
}

// ─── Fetch live Kambi soccer games ───────────────────────────────────────────

function winCurl(url: string): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '20', url],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 10 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    console.log('[kambi] curl error status:', r.status, r.stderr?.slice(0, 100));
    return null;
  }
  return r.stdout?.length > 10 ? r.stdout : null;
}

function fetchLiveGames(): LiveGame[] {
  const raw = winCurl(KAMBI_URL);
  if (!raw) { console.log('[kambi] Fetch failed'); return []; }

  let data: any;
  try { data = JSON.parse(raw); } catch { console.log('[kambi] JSON parse error'); return []; }

  const events: any[] = data.events ?? [];
  const games: LiveGame[] = [];

  for (const item of events) {
    const ev = item.event ?? {};
    const ld = item.liveData ?? {};

    if (ev.state !== 'STARTED') continue;

    const score = ld.score ?? {};
    const clock = ld.matchClock ?? {};
    const homeScore = parseInt(score.home ?? '0', 10);
    const awayScore = parseInt(score.away ?? '0', 10);
    const minute    = parseInt(String(clock.minute ?? '0'), 10);
    const period    = (clock.period ?? '').toLowerCase();
    if (isNaN(homeScore) || isNaN(awayScore) || isNaN(minute)) continue;

    // Extract 1X2 match odds from betOffers
    let homeOdds = 0, drawOdds = 0, awayOdds = 0;
    for (const bo of item.betOffers ?? []) {
      if (bo.betOfferType?.englishName !== 'Match') continue;
      for (const o of bo.outcomes ?? []) {
        const dec = (o.odds ?? 0) / 1000;
        if (o.type === 'OT_ONE')   homeOdds = dec;
        if (o.type === 'OT_CROSS') drawOdds = dec;
        if (o.type === 'OT_TWO')   awayOdds = dec;
      }
    }
    if (homeOdds < 1.01 && awayOdds < 1.01) continue; // no odds available

    // Implied probabilities (raw, no vig removal — conservative)
    const homeProb = homeOdds > 1 ? 1 / homeOdds : 0;
    const awayProb = awayOdds > 1 ? 1 / awayOdds : 0;

    games.push({
      eventId:   ev.id,
      homeName:  ev.homeName ?? '',
      awayName:  ev.awayName ?? '',
      homeScore, awayScore, minute, period,
      group:     ev.group ?? '',
      homeOdds,  drawOdds,  awayOdds,
      homeProb,  awayProb,
    });
  }

  return games;
}

// ─── Fetch Polymarket soccer markets ─────────────────────────────────────────

interface PolyMarket {
  conditionId: string;
  question:    string;
  yesPrice:    number;
  liquidity:   number;
  tokenId:     string;
}

async function fetchSoccerMarkets(): Promise<PolyMarket[]> {
  const markets: PolyMarket[] = [];
  try {
    const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
    if (!raw) throw new Error('empty response');
    const all: any[] = JSON.parse(raw);
    for (const m of all) {
      const q = (m.question ?? '').toLowerCase();
      // Filter to soccer/football markets
      if (!/win|beat|defeat|match|soccer|football|premier|bundesliga|serie|liga|ligue|cl|ucl|fa cup|copa/i.test(q)) continue;
      const prices = JSON.parse(m.outcomePrices ?? '[]');
      if (prices.length < 2) continue;
      const yesPrice = parseFloat(prices[0]);
      if (isNaN(yesPrice) || yesPrice <= 0) continue;
      const liq = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
      if (liq < 100) continue;

      const tokens = JSON.parse(m.tokens ?? m.clobTokenIds ?? '[]');
      markets.push({
        conditionId: m.conditionId,
        question:    m.question,
        yesPrice,
        liquidity:   liq,
        tokenId:     tokens[0] ?? '',
      });
    }
  } catch (e: any) {
    console.log('[kambi] Market fetch error:', e.message);
  }
  return markets;
}

// ─── Match Kambi game to Polymarket question ──────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Team name aliases: Kambi name → common Polymarket name variants
const TEAM_ALIASES: Record<string, string[]> = {
  'athletic bilbao': ['athletic club', 'bilbao', 'athletic'],
  'atletico madrid': ['atletico', 'atletico de madrid', 'atl madrid'],
  'real madrid': ['real madrid', 'madrid'],
  'paris saint germain': ['psg', 'paris sg', 'paris saint-germain', 'paris'],
  'borussia dortmund': ['dortmund', 'bvb', 'borussia'],
  'borussia monchengladbach': ['gladbach', 'monchengladbach'],
  'rb leipzig': ['red bull leipzig', 'rb leipzig', 'rasenball'],
  'internazionale': ['inter milan', 'inter', 'fc inter'],
  'ac milan': ['ac milan', 'milan'],
  'ss lazio': ['lazio'],
  'as roma': ['roma'],
  'manchester united': ['man united', 'man utd', 'manchester utd'],
  'manchester city': ['man city', 'manchester city'],
  'tottenham hotspur': ['tottenham', 'spurs', 'hotspur'],
  'west ham united': ['west ham'],
  'aston villa': ['aston villa', 'villa'],
  'newcastle united': ['newcastle'],
  'benfica': ['sl benfica', 'sport lisboa e benfica'],
  'sporting cp': ['sporting lisbon', 'sporting'],
  'porto': ['fc porto'],
  'ajax': ['ajax amsterdam', 'afc ajax'],
  'psv': ['psv eindhoven'],
  'celtic': ['celtic fc'],
  'rangers': ['rangers fc', 'glasgow rangers'],
};

function teamInQuestion(teamName: string, question: string): boolean {
  const q  = normalize(question);
  const tn = normalize(teamName);

  // Exact match
  if (q.includes(tn)) return true;

  // Check alias table
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const isThisTeam = tn === canonical || aliases.some(a => tn === a || tn.includes(a) || a.includes(tn));
    if (isThisTeam) {
      const matchesQ = q.includes(canonical) || aliases.some(a => q.includes(a));
      if (matchesQ) return true;
    }
  }

  // Word-based matching: ALL significant words must appear
  const words = tn.split(' ').filter(w => w.length >= 5);
  if (words.length >= 2) return words.every(w => q.includes(w));

  // Single significant word with word boundary
  if (words.length === 1) {
    const w = words[0];
    const idx = q.indexOf(w);
    if (idx === -1) return false;
    const before = idx === 0 || /\s/.test(q[idx - 1]);
    const after  = idx + w.length >= q.length || /\s/.test(q[idx + w.length]);
    return before && after;
  }
  return false;
}

interface Signal {
  game:       LiveGame;
  market:     PolyMarket;
  side:       'YES' | 'NO';
  polyPrice:  number;  // current Polymarket price
  bookProb:   number;  // bookmaker implied prob for this side
  edge:       number;  // bookProb - polyPrice
  type:       'SCORE' | 'ODDS';
  reason:     string;
}

function findSignals(games: LiveGame[], markets: PolyMarket[]): Signal[] {
  const signals: Signal[] = [];

  for (const game of games) {
    const lead     = game.homeScore - game.awayScore;
    const absLead  = Math.abs(lead);
    const leadTeam = lead > 0 ? game.homeName : game.awayName;
    const trailTeam = lead > 0 ? game.awayName : game.homeName;

    for (const market of markets) {
      const q = market.question;

      // Does this market mention either team?
      const mentionsHome = teamInQuestion(game.homeName, q);
      const mentionsAway = teamInQuestion(game.awayName, q);
      if (!mentionsHome && !mentionsAway) continue;

      // Women's team mismatch guard: don't match women's games to men's markets
      const isWomensGame = /\(w\)|\bwomen\b|\bwomens\b/i.test(game.homeName) ||
                           /\(w\)|\bwomen\b|\bwomens\b/i.test(game.awayName) ||
                           /\bwomen\b|\bwomens\b/i.test(game.group);
      const isWomensMarket = /\bwomen\b|\bwomens\b|\bwwc\b|\bwoman\b/i.test(q);
      if (isWomensGame && !isWomensMarket) continue;
      if (!isWomensGame && isWomensMarket) continue;

      // Determine which outcome to bet
      // "Will X win?" → YES if X is winning convincingly, NO if X is losing badly
      const questionFavorsHome = mentionsHome && /win|beat|defeat/i.test(q);
      const questionFavorsAway = mentionsAway && /win|beat|defeat/i.test(q);

      // ── SCORE SIGNAL ─────────────────────────────────────────────
      if (game.minute >= MIN_MINUTE_SCORE && absLead >= MIN_LEAD_GOALS) {
        // Big lead late in game
        const leadingHome = lead > 0;
        const polyBooksMatch = questionFavorsHome === leadingHome;

        let polyPrice  = market.yesPrice;
        let bookProb   = leadingHome ? game.homeProb : game.awayProb;
        let side: 'YES' | 'NO' = 'YES';

        if (!polyBooksMatch) {
          // Polymarket is betting on the LOSING team winning → bet NO (buy NO = buy YES on counter)
          polyPrice = 1 - market.yesPrice;
          bookProb  = leadingHome ? game.awayProb : game.homeProb;
          // Skip NO bets for now — complex, need to flip token
          continue;
        }

        const edge = bookProb - polyPrice;
        if (edge < MIN_SCORE_EDGE) continue;

        signals.push({
          game, market, side, polyPrice, bookProb, edge,
          type:   'SCORE',
          reason: `${game.minute}' ${leadTeam} leads ${game.homeScore}-${game.awayScore} ${trailTeam}, book=${(bookProb*100).toFixed(0)}% poly=${(polyPrice*100).toFixed(0)}%`,
        });
      }

      // ── ODDS SIGNAL ───────────────────────────────────────────────
      if (game.minute >= MIN_MINUTE_ODDS) {
        const probForHome = game.homeProb;
        const probForAway = game.awayProb;

        if (questionFavorsHome && probForHome > 0) {
          const edge = probForHome - market.yesPrice;
          if (edge >= MIN_SCORE_EDGE) {
            signals.push({
              game, market,
              side: 'YES',
              polyPrice: market.yesPrice,
              bookProb:  probForHome,
              edge, type: 'ODDS',
              reason: `Kambi book: ${game.homeName} win prob ${(probForHome*100).toFixed(0)}% vs Poly ${(market.yesPrice*100).toFixed(0)}%`,
            });
          }
        }
        if (questionFavorsAway && probForAway > 0) {
          const edge = probForAway - market.yesPrice;
          if (edge >= MIN_SCORE_EDGE) {
            signals.push({
              game, market,
              side: 'YES',
              polyPrice: market.yesPrice,
              bookProb:  probForAway,
              edge, type: 'ODDS',
              reason: `Kambi book: ${game.awayName} win prob ${(probForAway*100).toFixed(0)}% vs Poly ${(market.yesPrice*100).toFixed(0)}%`,
            });
          }
        }
      }
    }
  }

  // Sort by edge descending
  return signals.sort((a, b) => b.edge - a.edge);
}

// ─── Main scan + trade cycle ──────────────────────────────────────────────────

async function runCycle() {
  const open = getOpenPositions().filter(p => p.strategy === 'kambi-soccer');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[kambi] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  if (ARMED) {
    let usdc = 0;
    try { usdc = await getUsdcBalance(); } catch {}
    if (usdc < 1) { console.log('[kambi] Insufficient balance'); return; }
  }

  console.log('[kambi] Fetching live Kambi games...');
  const games = fetchLiveGames();
  console.log(`[kambi] ${games.length} live soccer games`);

  if (games.length === 0) return;

  // Print live scores
  for (const g of games.slice(0, 5)) {
    console.log(`  [${g.minute}'] ${g.homeName} ${g.homeScore}-${g.awayScore} ${g.awayName} | home=${(g.homeProb*100).toFixed(0)}% away=${(g.awayProb*100).toFixed(0)}%`);
  }

  console.log('[kambi] Fetching Polymarket soccer markets...');
  const markets = await fetchSoccerMarkets();
  console.log(`[kambi] ${markets.length} Polymarket soccer markets`);

  const signals = findSignals(games, markets);
  console.log(`[kambi] ${signals.length} signals found`);

  const heldIds  = open.map(p => p.conditionId);
  const fresh    = signals.filter(s => !heldIds.includes(s.market.conditionId));
  const toTrade  = fresh.slice(0, MAX_POSITIONS - open.length);

  if (toTrade.length === 0) {
    console.log('[kambi] No new edges this cycle');
    return;
  }

  for (const sig of toTrade) {
    console.log(`\n[kambi] 🎯 ${sig.type} EDGE: ${sig.reason}`);
    console.log(`  Market: ${sig.market.question.slice(0, 80)}`);
    console.log(`  Edge: ${(sig.edge * 100).toFixed(1)}% | Bet: $${BET_SIZE_USD}`);

    if (!ARMED) {
      console.log(`  [DRY RUN] Would buy ${sig.side} @ ${sig.polyPrice.toFixed(2)}`);
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) {
        console.log('[kambi] Market not accepting orders');
        continue;
      }

      const shares = Math.floor(BET_SIZE_USD / sig.polyPrice);
      if (shares < 5) { console.log('[kambi] Too few shares, skip'); continue; }

      const orderId = await placeBuy({
        tokenId:  sig.market.tokenId,
        price:    sig.polyPrice,
        size:     BET_SIZE_USD,
        side:     sig.side,
      });

      addPosition({
        conditionId: sig.market.conditionId,
        question:    sig.market.question,
        side:        sig.side,
        entryPrice:  sig.polyPrice,
        shares,
        cost:        BET_SIZE_USD,
        strategy:    'kambi-soccer',
      });

      const msg = `⚽ Kambi ${sig.type}: ${sig.reason} | $${BET_SIZE_USD} → order ${orderId}`;
      await tg(msg);
      console.log('[kambi] ✅', msg);
    } catch (e: any) {
      console.log('[kambi] ❌ Order error:', e.message);
      await tg(`❌ Kambi order failed: ${e.message}`);
    }
  }
}

// ─── Export for runner ────────────────────────────────────────────────────────

export async function runKambiSoccer(): Promise<void> {
  const monitor = process.argv.includes('--monitor');
  console.log(`[kambi] Starting soccer arb | ARMED=${ARMED} | monitor=${monitor}`);

  await runCycle();

  if (monitor) {
    setInterval(runCycle, SCAN_INTERVAL);
    console.log(`[kambi] Scanning every ${SCAN_INTERVAL / 60000} min`);
    await new Promise(() => {}); // keep alive
  }
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (process.argv[1]?.endsWith('kambi-soccer.ts') || process.argv[1]?.endsWith('kambi-soccer.js')) {
  runKambiSoccer().catch(console.error);
}
