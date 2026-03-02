/**
 * Esports Oracle Strategy
 *
 * Finds esports markets using Polymarket's tag_slug=esports query.
 * Data sources:
 *  - Riot LoL Esports API (free, no auth beyond x-api-key header)
 *    LCK schedule: leagueId=98767991310872058
 *    LPL schedule: leagueId=98767991314006698
 *    VCT: leagueId=107213827295848783
 *  - Kambi esports (CS2/Dota2 when available)
 *  - Oracle-arb: markets at 88¢+ near expiry with known winner
 *
 * Run: ARMED=true npx tsx src/strategies/esports-oracle.ts
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { logPaperTrade } from '../shared/paper-trader.js';
import { detectCategory } from '../shared/execute-signal.js';
import { spawnSync } from 'child_process';

const ARMED          = process.env.ARMED === 'true';
const MAX_POSITIONS  = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL  = 10 * 60_000;  // 10 min
const GAMMA_HOST     = 'https://gamma-api.polymarket.com';
const BET_SIZE_USD   = 1;
const MIN_EDGE       = 0.07;
const MIN_ORACLE_ARB = 0.88;

const LOL_API_KEY    = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LOL_API_BASE   = 'https://esports-api.lolesports.com/persisted/gw';

// LCK/LPL/VCT league IDs (Riot esports API)
const LEAGUES: Record<string, string> = {
  LCK:  '98767991310872058',
  LPL:  '98767991314006698',
  LEC:  '98767991302996019',
  VCT:  '107213827295848783',
  // CDL: '107213827295849080',
};

// ─── Utilities ─────────────────────────────────────────────────────────────

function winCurl(url: string, extraHeaders: string[] = []): string | null {
  const args = ['-s', '--max-time', '15', ...extraHeaders, url];
  const r = spawnSync('/mnt/c/Windows/System32/curl.exe', args, {
    encoding: 'utf8', timeout: 18000, maxBuffer: 10 * 1024 * 1024
  });
  return r.status === 0 && (r.stdout?.length ?? 0) > 50 ? r.stdout : null;
}

function lolCurl(path: string): any {
  const raw = winCurl(`${LOL_API_BASE}${path}`, ['-H', `x-api-key: ${LOL_API_KEY}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Fetch esports markets from Polymarket (tag-based) ──────────────────────

interface EsportsMarket {
  conditionId: string;
  question:    string;
  yesPrice:    number;
  liquidity:   number;
  tokenId:     string;
  endDate:     Date | null;
  hoursLeft:   number;
}

function fetchEsportsMarkets(): EsportsMarket[] {
  const raw = winCurl(`${GAMMA_HOST}/events?limit=100&active=true&closed=false&tag_slug=esports`);
  if (!raw) return [];

  let events: any[];
  try { events = JSON.parse(raw); } catch { return []; }

  const now    = Date.now();
  const result: EsportsMarket[] = [];

  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      if (!m.acceptingOrders) continue;
      const prices   = JSON.parse(m.outcomePrices ?? '[]');
      const yesPrice = parseFloat(prices[0]) || 0;
      if (yesPrice <= 0 || yesPrice >= 0.999) continue;
      const liq = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
      if (liq < 200) continue;
      const endDate   = m.endDate ? new Date(m.endDate) : null;
      const hoursLeft = endDate ? (endDate.getTime() - now) / 3_600_000 : 999;
      const tokens    = JSON.parse(m.clobTokenIds ?? m.tokens ?? '[]');
      result.push({ conditionId: m.conditionId, question: m.question ?? '', yesPrice, liquidity: liq, tokenId: tokens[0] ?? '', endDate, hoursLeft });
    }
  }
  return result;
}

// ─── LoL standings via Riot API ─────────────────────────────────────────────

interface TeamStanding {
  name:   string;
  wins:   number;
  losses: number;
  league: string;
}

function getLolStandings(): TeamStanding[] {
  const standings: TeamStanding[] = [];
  const now = new Date().toISOString().slice(0, 4); // current year

  for (const [league, leagueId] of Object.entries(LEAGUES)) {
    if (league === 'VCT') continue; // different API
    const d = lolCurl(`/getSchedule?hl=en-US&leagueId=${leagueId}`);
    if (!d) continue;

    const events = d.data?.schedule?.events ?? [];
    const wins: Record<string, number> = {};
    const losses: Record<string, number> = {};

    for (const ev of events) {
      if (ev.state !== 'completed') continue;
      if (!ev.startTime?.startsWith(now)) continue;
      for (const team of ev.match?.teams ?? []) {
        const name = team.name ?? '';
        if (!wins[name]) { wins[name] = 0; losses[name] = 0; }
        if (team.result?.outcome === 'win') wins[name]++;
        else if (team.result?.outcome === 'loss') losses[name]++;
      }
    }

    const sorted = Object.keys(wins).sort((a, b) => (wins[b] - losses[b]) - (wins[a] - losses[a]));
    for (const name of sorted) {
      standings.push({ name, wins: wins[name], losses: losses[name], league });
    }
  }

  return standings;
}

// ─── Match standing to market question ───────────────────────────────────────

function teamMatchesQuestion(teamName: string, question: string): boolean {
  const q  = normalize(question);
  const tn = normalize(teamName);
  if (q.includes(tn)) return true;

  // Common abbreviations
  const abbrevs: [string, string[]][] = [
    ['geng', ['gen.g', 'geng', 'gen g']],
    ['t1', ['t1', 'sk telecom', 'skt']],
    ['dplus kia', ['dplus', 'dplus kia', 'damwon', 'dk']],
    ['kt rolster', ['kt rolster', 'kt', 'kt']],
    ['hanwha life', ['hanwha', 'hanwha life', 'hle']],
    ['bnk fearx', ['fearx', 'bnk fearx', 'bnk']],
    ['nongshim redforce', ['nongshim', 'redforce', 'nongshim redforce', 'ns']],
    ['drx', ['drx']],
    ['beijing jdg', ['jdg', 'beijing jdg', 'jd gaming']],
    ['weibogaming', ['weibo', 'weibogaming', 'wbg']],
    ['bilibili gaming', ['blg', 'bilibili gaming', 'bilibili']],
  ];

  for (const [canonical, variants] of abbrevs) {
    const teamMatches = variants.some(v => tn.includes(v) || canonical.includes(tn));
    if (teamMatches && variants.some(v => q.includes(v) || q.includes(canonical))) return true;
  }
  return false;
}

// ─── Main scan cycle ─────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const open = getOpenPositions().filter(p => p.strategy === 'esports-oracle');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[esports] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  // Fetch markets
  console.log('[esports] Fetching esports markets (tag_slug=esports)...');
  const markets = fetchEsportsMarkets();
  console.log(`[esports] ${markets.length} tradeable esports markets`);

  if (markets.length === 0) { console.log('[esports] No markets found'); return; }

  if (ARMED) {
    const usdc = await getUsdcBalance();
    if (usdc < 1) { console.log('[esports] Insufficient balance'); return; }
  }

  // Fetch LoL standings
  console.log('[esports] Fetching LoL standings...');
  const standings = getLolStandings();
  if (standings.length > 0) {
    const byLeague: Record<string, TeamStanding[]> = {};
    for (const s of standings) {
      if (!byLeague[s.league]) byLeague[s.league] = [];
      byLeague[s.league].push(s);
    }
    for (const [league, teams] of Object.entries(byLeague)) {
      const top3 = teams.slice(0, 3);
      console.log(`  ${league}: ${top3.map(t => `${t.name}(${t.wins}W)`).join(', ')}`);
    }
  }

  const heldIds = open.map(p => p.conditionId);
  const signals: any[] = [];

  // ORACLE ARB: markets at 88¢+ near expiry — winner already determined
  const oracleTargets = markets.filter(m => m.yesPrice >= MIN_ORACLE_ARB && m.hoursLeft < 120);
  for (const m of oracleTargets) {
    if (heldIds.includes(m.conditionId)) continue;
    const edge = 1.0 - m.yesPrice;
    signals.push({
      type: 'ORACLE',
      market: m,
      confidence: 0.97,
      edge,
      reason: `Oracle lag: YES at ${m.yesPrice.toFixed(2)}, ${m.hoursLeft.toFixed(0)}h left`,
    });
  }

  // LIVE STANDINGS: match leading team to season winner markets
  for (const standing of standings) {
    const teamWinRate = standing.wins / (standing.wins + standing.losses + 0.01);
    if (standing.wins < 4 || teamWinRate < 0.65) continue; // Only very dominant teams

    for (const market of markets) {
      if (heldIds.includes(market.conditionId)) continue;
      if (!teamMatchesQuestion(standing.name, market.question)) continue;
      if (!/will .+ win/i.test(market.question)) continue;

      // Expected probability: dominant team gets +12% boost on market price.
      // Cap at 0.45 — even 8-0 teams rarely exceed 45% in a multi-team league.
      // Skip longshots (<5¢) — they're priced low because ~10-16 teams compete.
      if (market.yesPrice < 0.05) continue;
      const expectedProb = Math.min(market.yesPrice + 0.12, 0.45);
      const edge = expectedProb - market.yesPrice;
      if (edge < MIN_EDGE) continue;

      signals.push({
        type: 'STANDINGS',
        team: standing.name,
        market,
        confidence: expectedProb,
        edge,
        reason: `${standing.league} leader: ${standing.name} ${standing.wins}W-${standing.losses}L (${(teamWinRate*100).toFixed(0)}% win rate)`,
      });
    }
  }

  signals.sort((a, b) => b.edge - a.edge);
  console.log(`[esports] ${signals.length} signals (${oracleTargets.length} oracle-arb, ${signals.length - oracleTargets.length} standings)`);

  for (const sig of signals.slice(0, MAX_POSITIONS - open.length)) {
    console.log(`\n[esports] 🎮 ${sig.type}: ${sig.reason || sig.market.question.slice(0, 60)}`);
    console.log(`  Market: ${sig.market.question.slice(0, 80)}`);
    console.log(`  YES=${sig.market.yesPrice.toFixed(3)} | Edge: ${(sig.edge*100).toFixed(1)}% | Liq: $${sig.market.liquidity.toFixed(0)}`);

    if (!ARMED) {
      logPaperTrade({
        strategy: 'esports-oracle', category: detectCategory(sig.market.question),
        question: sig.market.question, conditionId: sig.market.conditionId,
        side: 'YES', entryPrice: sig.market.yesPrice,
        confidence: sig.confidence, edge: sig.edge,
        signalReason: sig.reason,
      });
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) { console.log('[esports] Market not accepting orders'); continue; }

      const shares = Math.floor(BET_SIZE_USD / sig.market.yesPrice);
      if (shares < 5) { console.log('[esports] Too few shares'); continue; }

      await placeBuy({ tokenId: sig.market.tokenId, price: sig.market.yesPrice, size: BET_SIZE_USD, side: 'YES' });
      addPosition({ conditionId: sig.market.conditionId, question: sig.market.question, side: 'YES', entryPrice: sig.market.yesPrice, shares, cost: BET_SIZE_USD, strategy: 'esports-oracle' });

      const msg = `🎮 Esports ${sig.type}: ${sig.reason || sig.market.question.slice(0,60)} | $${BET_SIZE_USD} edge ${(sig.edge*100).toFixed(1)}%`;
      await tg(msg);
      console.log('[esports] ✅', msg);
    } catch (e: any) {
      console.log('[esports] ❌ Error:', e.message);
    }
  }
}

export async function runEsportsOracle(): Promise<void> {
  const monitor = process.argv.includes('--monitor');
  console.log(`[esports] Starting esports oracle | ARMED=${ARMED} | monitor=${monitor}`);
  await runCycle();
  if (monitor) {
    setInterval(runCycle, SCAN_INTERVAL);
    console.log(`[esports] Scanning every ${SCAN_INTERVAL / 60000} min`);
    await new Promise(() => {});
  }
}

if (process.argv[1]?.endsWith('esports-oracle.ts') || process.argv[1]?.endsWith('esports-oracle.js')) {
  runEsportsOracle().catch(console.error);
}
