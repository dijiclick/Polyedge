/**
 * Golf Oracle Strategy
 *
 * Monitors PGA Tour, LPGA, and European Tour tournaments via ESPN API.
 * When a tournament is FINAL (or in final round with dominant leader),
 * finds matching Polymarket "Will X win the [Tournament]?" markets and
 * buys YES before the oracle settles.
 *
 * Signal types:
 *  A) FINAL — tournament complete, winner confirmed → oracle-arb play
 *  B) DOMINANT — leader has 5+ shot lead in final round with few holes left → buy YES
 *
 * Run: ARMED=true npx tsx src/strategies/golf-oracle.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 10 * 60_000;  // 10 min
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';
const BET_SIZE_USD  = 1;
const MIN_EDGE      = 0.05;  // minimum 5% edge

// ESPN golf endpoints
const GOLF_TOURS = [
  { key: 'pga',  label: 'PGA Tour',        url: 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard' },
  { key: 'lpga', label: 'LPGA Tour',       url: 'https://site.api.espn.com/apis/site/v2/sports/golf/lpga/scoreboard' },
  { key: 'eur',  label: 'European Tour',   url: 'https://site.api.espn.com/apis/site/v2/sports/golf/eur/scoreboard' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface GolfLeader {
  name:        string;
  score:       number;   // relative to par (e.g. -17 means 17 under)
  lead:        number;   // strokes ahead of 2nd place
  position:    string;   // '1', 'T1', etc
}

interface TournamentResult {
  name:       string;   // "Cognizant Classic in The Palm Beaches"
  tour:       string;   // "PGA Tour"
  status:     'FINAL' | 'IN_PROGRESS' | 'OTHER';
  round:      number;   // 1–4
  holesLeft:  number;   // approximate holes remaining in tournament
  leader:     GolfLeader | null;
  top5:       GolfLeader[];
}

// ─── ESPN Fetch ───────────────────────────────────────────────────────────────

function winCurl(url: string): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '15', url],
    { encoding: 'utf8', timeout: 18000, maxBuffer: 10 * 1024 * 1024 }
  );
  return r.status === 0 && (r.stdout?.length ?? 0) > 10 ? r.stdout : null;
}

function fetchTournaments(): TournamentResult[] {
  const results: TournamentResult[] = [];

  for (const tour of GOLF_TOURS) {
    const raw = winCurl(tour.url);
    if (!raw) { console.log(`[golf] ${tour.label} fetch failed`); continue; }

    let data: any;
    try { data = JSON.parse(raw); } catch { continue; }

    for (const ev of data.events ?? []) {
      const comp       = ev.competitions?.[0];
      if (!comp) continue;

      const statusName  = ev.status?.type?.name ?? '';
      const statusState = ev.status?.type?.state ?? '';
      const round       = comp.status?.period ?? 0;

      let status: 'FINAL' | 'IN_PROGRESS' | 'OTHER' = 'OTHER';
      if (statusName === 'STATUS_FINAL' || statusState === 'post') status = 'FINAL';
      else if (statusState === 'in') status = 'IN_PROGRESS';

      if (status === 'OTHER') continue;

      // Parse competitors sorted by score (ESPN returns them sorted already)
      const competitors: any[] = comp.competitors ?? [];
      const parsed: GolfLeader[] = competitors
        .filter(c => c.score != null)
        .map(c => ({
          name:     c.athlete?.displayName ?? c.athlete?.name ?? '',
          score:    parseInt(String(c.score).replace('E', '0').replace('--', '0')) || 0,
          lead:     0,
          position: c.status?.position?.displayText ?? '',
        }))
        .sort((a, b) => a.score - b.score); // lower score = better in golf

      if (parsed.length === 0) continue;

      // Calculate lead (difference from 2nd)
      if (parsed.length >= 2) {
        parsed[0].lead = parsed[1].score - parsed[0].score;
      }

      // Estimate holes left (4 rounds × 18 holes)
      // round 4 = final round, ESPN doesn't give exact holes remaining easily
      // Use round as proxy: round 4 in-progress = ~0-18 holes left
      let holesLeft = (4 - round) * 18;
      if (status === 'FINAL') holesLeft = 0;

      results.push({
        name:      ev.name ?? ev.shortName ?? '',
        tour:      tour.label,
        status,
        round,
        holesLeft,
        leader:    parsed[0] ?? null,
        top5:      parsed.slice(0, 5),
      });
    }
  }

  return results;
}

// ─── Match tournament to Polymarket ──────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function playerInQuestion(playerName: string, question: string): boolean {
  const q  = normalize(question);
  const pn = normalize(playerName);
  if (q.includes(pn)) return true;
  // Match last name (golfers usually referenced by last name)
  const lastName = pn.split(' ').pop() ?? '';
  if (lastName.length >= 4) {
    const idx = q.indexOf(lastName);
    if (idx === -1) return false;
    const before = idx === 0 || /\s/.test(q[idx - 1]);
    const after  = idx + lastName.length >= q.length || /\s/.test(q[idx + lastName.length]);
    return before && after;
  }
  return false;
}

function tournamentInQuestion(tournamentName: string, question: string): boolean {
  const q   = normalize(question);
  const t   = normalize(tournamentName);
  // Try full name
  if (q.includes(t)) return true;
  // Try significant words (>= 5 chars, not generic golf words)
  const generic = new Set(['championship','classic','invitational','tournament','open','masters','players']);
  const words   = t.split(' ').filter(w => w.length >= 5 && !generic.has(w));
  if (words.length >= 2) return words.filter(w => q.includes(w)).length >= 2;
  if (words.length === 1) return q.includes(words[0]);
  // Fallback: check if question is about golf + this week's tournament
  return /golf|pga|lpga|tour/i.test(question);
}

interface GolfSignal {
  tournament:  TournamentResult;
  market:      any;
  player:      GolfLeader;
  side:        'YES';
  yesPrice:    number;
  tokenId:     string;
  confidence:  number;
  edge:        number;
  type:        'FINAL' | 'DOMINANT';
}

async function findSignals(tournaments: TournamentResult[]): Promise<GolfSignal[]> {
  // Fetch Polymarket golf/sports markets
  const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
  if (!raw) { console.log('[golf] Polymarket fetch failed'); return []; }

  let allMarkets: any[];
  try { allMarkets = JSON.parse(raw); } catch { return []; }

  // Filter to golf-related markets
  const golfMarkets = allMarkets.filter(m => {
    const q = (m.question ?? '').toLowerCase();
    return /golf|pga|lpga|masters|open championship|ryder cup|players championship|win.*tournament/i.test(q) ||
           /will \w[\w\s]+ win the/i.test(q);
  });
  console.log(`[golf] ${golfMarkets.length} golf-related Polymarket markets`);

  const signals: GolfSignal[] = [];

  for (const t of tournaments) {
    if (!t.leader) continue;

    for (const market of golfMarkets) {
      const q = market.question ?? '';

      // Check if player name is in the market question
      if (!playerInQuestion(t.leader.name, q)) continue;

      // Also require: either the tournament name is in the market, OR golf keywords are present
      const hasGolfContext = /golf|pga|lpga|masters|open|classic|invitational|championship|ryder|players/i.test(q);
      if (!hasGolfContext) continue;

      // Must be a win market for this player specifically, not a coincidental name match
      if (!/will .{0,50} win/i.test(q) && !/who will win/i.test(q)) continue;

      const prices   = JSON.parse(market.outcomePrices ?? '[]');
      const yesPrice = parseFloat(prices[0]);
      if (isNaN(yesPrice) || yesPrice <= 0) continue;

      const liq = parseFloat(market.liquidityNum ?? market.liquidity ?? '0');
      if (liq < 100) continue;

      const tokens  = JSON.parse(market.tokens ?? market.clobTokenIds ?? '[]');
      const tokenId = tokens[0] ?? '';

      let confidence = 0;
      let type: 'FINAL' | 'DOMINANT' = 'FINAL';

      if (t.status === 'FINAL') {
        // Tournament over — 100% certain, just oracle lag
        confidence = 0.97;
        type = 'FINAL';
      } else if (t.status === 'IN_PROGRESS' && t.round === 4) {
        // Final round in progress
        if (t.leader.lead >= 5 && t.holesLeft <= 9) {
          // 5+ shot lead with ≤9 holes left: ~95% certain
          confidence = Math.min(0.96, 0.88 + t.leader.lead * 0.01);
          type = 'DOMINANT';
        } else if (t.leader.lead >= 3 && t.holesLeft <= 5) {
          confidence = 0.90;
          type = 'DOMINANT';
        } else {
          continue; // not decisive enough
        }
      } else {
        continue;
      }

      const edge = confidence - yesPrice;
      if (edge < MIN_EDGE) continue;

      signals.push({ tournament: t, market, player: t.leader, side: 'YES', yesPrice, tokenId, confidence, edge, type });
      break; // one market per tournament leader
    }
  }

  return signals.sort((a, b) => b.edge - a.edge);
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const open = getOpenPositions().filter(p => p.strategy === 'golf-oracle');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[golf] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  console.log('[golf] Fetching tournament results...');
  const tournaments = fetchTournaments();
  console.log(`[golf] ${tournaments.length} tournaments found`);

  for (const t of tournaments) {
    const leaderStr = t.leader
      ? `${t.leader.name} (${t.leader.score > 0 ? '+' : ''}${t.leader.score}, +${t.leader.lead} lead)`
      : 'no leader';
    console.log(`  [${t.status} R${t.round}] ${t.tour}: ${t.name} — ${leaderStr}`);
  }

  if (tournaments.length === 0) { console.log('[golf] No active tournaments'); return; }

  if (ARMED) {
    const usdc = await getUsdcBalance();
    if (usdc < 1) { console.log('[golf] Insufficient balance'); return; }
  }

  const signals = await findSignals(tournaments);
  console.log(`[golf] ${signals.length} signals found`);

  const heldIds = open.map(p => p.conditionId);

  for (const sig of signals) {
    if (open.length + signals.indexOf(sig) >= MAX_POSITIONS) break;
    if (heldIds.includes(sig.market.conditionId)) continue;

    console.log(`\n[golf] 🏌️ ${sig.type} SIGNAL`);
    console.log(`  Player:     ${sig.player.name} (score=${sig.player.score}, lead=+${sig.player.lead})`);
    console.log(`  Tournament: ${sig.tournament.name} [${sig.tournament.tour}]`);
    console.log(`  Market:     ${sig.market.question?.slice(0, 80)}`);
    console.log(`  Confidence: ${(sig.confidence * 100).toFixed(0)}% | Poly: ${(sig.yesPrice * 100).toFixed(0)}¢ | Edge: ${(sig.edge * 100).toFixed(1)}%`);

    if (!ARMED) {
      console.log(`  [DRY RUN] Would buy YES @ ${sig.yesPrice.toFixed(2)} for $${BET_SIZE_USD}`);
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) { console.log('[golf] Market not accepting orders'); continue; }

      const shares = Math.floor(BET_SIZE_USD / sig.yesPrice);
      if (shares < 5) { console.log('[golf] Too few shares, skip'); continue; }

      const orderId = await placeBuy({
        tokenId:  sig.tokenId,
        price:    sig.yesPrice,
        size:     BET_SIZE_USD,
        side:     'YES',
      });

      addPosition({
        conditionId: sig.market.conditionId,
        question:    sig.market.question,
        side:        'YES',
        entryPrice:  sig.yesPrice,
        shares,
        cost:        BET_SIZE_USD,
        strategy:    'golf-oracle',
      });

      const msg = `🏌️ Golf ${sig.type}: ${sig.player.name} wins ${sig.tournament.name} | $${BET_SIZE_USD} @ ${(sig.yesPrice*100).toFixed(0)}¢ | edge ${(sig.edge*100).toFixed(1)}%`;
      await tg(msg);
      console.log('[golf] ✅', msg);
    } catch (e: any) {
      console.log('[golf] ❌ Error:', e.message);
      await tg(`❌ Golf oracle error: ${e.message}`);
    }
  }
}

// ─── Export + standalone ──────────────────────────────────────────────────────

export async function runGolfOracle(): Promise<void> {
  const monitor = process.argv.includes('--monitor');
  console.log(`[golf] Starting golf oracle | ARMED=${ARMED} | monitor=${monitor}`);

  await runCycle();

  if (monitor) {
    setInterval(runCycle, SCAN_INTERVAL);
    console.log(`[golf] Scanning every ${SCAN_INTERVAL / 60000} min`);
    await new Promise(() => {});
  }
}

if (process.argv[1]?.endsWith('golf-oracle.ts') || process.argv[1]?.endsWith('golf-oracle.js')) {
  runGolfOracle().catch(console.error);
}
