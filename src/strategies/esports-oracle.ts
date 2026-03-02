/**
 * Esports Oracle Strategy
 *
 * Monitors Polymarket for esports markets (LoL, CS2, Valorant, Dota2).
 * When markets exist, fetches live/recent match results from:
 *  - VLR.gg (Valorant Championship Tour)
 *  - HLTV.org (CS2 matches)
 *  - Liquipedia (all games, Wikipedia-style)
 *
 * Also applies oracle-arb logic: if tournament is over but market hasn't
 * settled yet (e.g. "Will Team X win Worlds?"), buys YES at 88-98¢.
 *
 * Note: Esports markets appear on Polymarket mainly during:
 *  - LoL Worlds (October)
 *  - CS2 Majors (spring/fall)
 *  - VCT (Valorant Champions Tour, Aug-Sep)
 *  - Dota 2 The International (October)
 *
 * Run: ARMED=true npx tsx src/strategies/esports-oracle.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED          = process.env.ARMED === 'true';
const MAX_POSITIONS  = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL  = 10 * 60_000;  // 10 min
const GAMMA_HOST     = 'https://gamma-api.polymarket.com';
const BET_SIZE_USD   = 1;
const MIN_EDGE       = 0.07;
const MIN_ORACLE_ARB = 0.88;  // buy YES at 88¢+ for oracle-arb

// Known esport teams/orgs for matching Polymarket questions
const ESPORTS_ORGS = [
  // CS2
  'navi', 'natus vincere', 'faze', 'vitality', 'astralis', 'liquid', 'g2', 'heroic',
  'mouz', 'spiritcouncil', 'spirit', 'entropiq', 'ence', 'ninjas in pyjamas', 'nip',
  'cloud9', 'fnatic', 'big', 'complexity', 'furia', 'mibr', 'imperial',
  // LoL
  't1', 'gen.g', 'cloud9', 'team liquid', 'c9', 'fnc', 'fnatic', 'g2', 'mad lions',
  'karmine corp', 'kc', 'loud', 'nrg', 'team solo mid', 'tsm', 'nrg',
  'kt rolster', 'dragonx', 'dk', 'hanwha', 'jdg', 'weibo', 'blg', 'lng',
  // Valorant
  'sentinels', 'nrg', 'cloud9', 'loud', 'fnc', 'navi', 'edg', 'drx',
  'paper rex', 'prx', 'evil geniuses', 'eg', 'optic', 'nrg',
  // Dota 2
  'og', 'team secret', 'liquid', 'virtus.pro', 'vp', 'navi', 'psg.lgd',
  'team spirit', 'gaimin gladiators', 'tundra', 'talon',
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function winCurl(url: string, extraArgs: string[] = []): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', '15', '-L', ...extraArgs, url],
    { encoding: 'utf8', timeout: 18000, maxBuffer: 10 * 1024 * 1024 }
  );
  return r.status === 0 && (r.stdout?.length ?? 0) > 50 ? r.stdout : null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Fetch esports markets from Polymarket ────────────────────────────────────

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
  const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
  if (!raw) return [];

  let all: any[];
  try { all = JSON.parse(raw); } catch { return []; }

  const now     = Date.now();
  const markets = all.filter(m => {
    const q = (m.question ?? '').toLowerCase();
    // Must explicitly mention esports games/events — no fuzzy org matching
    return /\b(cs2|csgo|cs:go|counter.strike 2|counter-strike|valorant|league of legends|dota 2|dota2|overwatch 2|esport|iem|blast premier|esl pro league|vct|lck|lec|lpl|rift rivals|rift|worlds 202|the international 202)\b/i.test(q);
  });

  return markets.map(m => {
    const prices   = JSON.parse(m.outcomePrices ?? '[]');
    const yesPrice = parseFloat(prices[0]) || 0;
    const liq      = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
    const endDate  = m.endDate ? new Date(m.endDate) : null;
    const hoursLeft = endDate ? (endDate.getTime() - now) / 3_600_000 : 999;
    const tokens   = JSON.parse(m.tokens ?? m.clobTokenIds ?? '[]');

    return { conditionId: m.conditionId, question: m.question ?? '', yesPrice, liquidity: liq, tokenId: tokens[0] ?? '', endDate, hoursLeft };
  }).filter(m => m.yesPrice > 0 && m.liquidity >= 100);
}

// ─── Scrape VLR.gg for Valorant results ──────────────────────────────────────

interface EsportsResult {
  team1:    string;
  team2:    string;
  winner:   string;
  score:    string;   // "2-0", "2-1" etc
  game:     string;   // 'valorant', 'cs2', 'lol', 'dota2'
  event:    string;   // tournament name
  date:     Date;
}

function scrapeVLR(): EsportsResult[] {
  const raw = winCurl('https://vlr.gg/matches/results', ['-H', 'User-Agent: Mozilla/5.0']);
  if (!raw) return [];

  const results: EsportsResult[] = [];
  // VLR match result pattern: team names + scores in match result cards
  const matchBlocks = raw.match(/<a href="\/\d+[^"]*"[^>]*class="[^"]*match[^"]*"[\s\S]*?<\/a>/gi) ?? [];

  for (const block of matchBlocks.slice(0, 20)) {
    const teams = block.match(/class="[^"]*team[^"]*"[^>]*>([\w\s.]+)<\/div>/gi) ?? [];
    const scores = block.match(/class="[^"]*score[^"]*"[^>]*>(\d)<\/span>/gi) ?? [];
    const event = block.match(/class="[^"]*event[^"]*"[^>]*>([\w\s]+)<\/span>/)?.[1]?.trim() ?? '';

    if (teams.length >= 2 && scores.length >= 2) {
      const t1 = teams[0].replace(/<[^>]+>/g, '').trim();
      const t2 = teams[1].replace(/<[^>]+>/g, '').trim();
      const s1 = parseInt(scores[0].replace(/<[^>]+>/g, ''));
      const s2 = parseInt(scores[1].replace(/<[^>]+>/g, ''));
      const winner = s1 > s2 ? t1 : t2;
      results.push({ team1: t1, team2: t2, winner, score: `${s1}-${s2}`, game: 'valorant', event, date: new Date() });
    }
  }
  return results;
}

function scrapeHLTV(): EsportsResult[] {
  // HLTV blocks scrapers heavily — skip for now, use Kambi when CS2 events are live
  return [];
}

function fetchKambiEsports(): EsportsResult[] {
  // Kambi has esports section — check if any live
  const raw = winCurl(
    'https://eu-offering-api.kambicdn.com/offering/v2018/ubse/listView/esport.json?lang=en_GB&market=SE&client_id=2&channel_id=1&ncid=1&useCombined=true&startIndex=0&stopIndex=100',
    ['--max-time', '15']
  );
  if (!raw) return [];

  let data: any;
  try { data = JSON.parse(raw); } catch { return []; }

  const results: EsportsResult[] = [];
  for (const item of data.events ?? []) {
    const ev = item.event ?? {};
    const ld = item.liveData ?? {};

    if (ev.state !== 'STARTED' && ev.state !== 'FINISHED') continue;

    const score  = ld.score ?? {};
    const home   = parseInt(score.home ?? '0');
    const away   = parseInt(score.away ?? '0');
    const winner = home > away ? ev.homeName : ev.awayName;
    const game   = (ev.group ?? '').toLowerCase().includes('cs') ? 'cs2'
                 : (ev.group ?? '').toLowerCase().includes('league') ? 'lol'
                 : (ev.group ?? '').toLowerCase().includes('dota') ? 'dota2'
                 : (ev.group ?? '').toLowerCase().includes('valorant') ? 'valorant'
                 : 'esports';

    results.push({
      team1:  ev.homeName ?? '',
      team2:  ev.awayName ?? '',
      winner: home > away ? ev.homeName : home < away ? ev.awayName : '',
      score:  `${home}-${away}`,
      game,
      event:  ev.group ?? '',
      date:   new Date(),
    });
  }
  return results;
}

// ─── Match result to Polymarket question ─────────────────────────────────────

function teamMatchesMarket(teamName: string, question: string): boolean {
  const q   = normalize(question);
  const tn  = normalize(teamName);
  if (q.includes(tn)) return true;

  // Check known abbreviations / alternate names
  const abbrevMap: Record<string, string[]> = {
    'natus vincere': ['navi', 'natus vincere'],
    'fnatic': ['fnatic', 'fnc'],
    'team liquid': ['liquid', 'team liquid'],
    'cloud9': ['cloud9', 'c9'],
    'team spirit': ['spirit', 'team spirit'],
  };

  for (const [full, variants] of Object.entries(abbrevMap)) {
    if (tn.includes(full) || variants.some(v => tn.includes(v))) {
      if (variants.some(v => q.includes(v) || q.includes(full))) return true;
    }
  }
  return false;
}

// ─── Main scan cycle ──────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const open = getOpenPositions().filter(p => p.strategy === 'esports-oracle');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[esports] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  // Check if any esports markets exist
  console.log('[esports] Checking Polymarket for esports markets...');
  const esportsMarkets = fetchEsportsMarkets();
  console.log(`[esports] ${esportsMarkets.length} esports markets found`);

  if (esportsMarkets.length === 0) {
    console.log('[esports] No esports markets active — waiting for next major tournament');
    console.log('[esports] (Markets appear during LoL Worlds, CS2 Majors, VCT, The International)');
    return;
  }

  if (ARMED) {
    const usdc = await getUsdcBalance();
    if (usdc < 1) { console.log('[esports] Insufficient balance'); return; }
  }

  // ── Oracle Arb: markets near 98¢ with expired/near-expired dates ──
  const oracleTargets = esportsMarkets.filter(m => m.yesPrice >= MIN_ORACLE_ARB && m.hoursLeft < 72);
  if (oracleTargets.length > 0) {
    console.log(`[esports] ${oracleTargets.length} oracle-arb targets (${MIN_ORACLE_ARB*100}¢+)`);
    for (const m of oracleTargets) {
      const edge = (1.0 - m.yesPrice) / m.yesPrice;
      console.log(`  ${m.question.slice(0, 70)} | YES=${m.yesPrice.toFixed(2)} | edge=${(edge*100).toFixed(1)}%`);
    }
  }

  // ── Fetch live results ──
  const results: EsportsResult[] = [
    ...scrapeVLR(),
    ...fetchKambiEsports(),
  ];
  console.log(`[esports] ${results.length} recent match results`);

  const signals: any[] = [];
  const heldIds = open.map(p => p.conditionId);

  // Match results to markets
  for (const result of results) {
    if (!result.winner) continue;
    for (const market of esportsMarkets) {
      if (heldIds.includes(market.conditionId)) continue;
      if (!teamMatchesMarket(result.winner, market.question)) continue;
      if (!/will .+ win/i.test(market.question)) continue;

      const confidence = 0.94;
      const edge = confidence - market.yesPrice;
      if (edge < MIN_EDGE) continue;

      signals.push({
        type: 'RESULT',
        team: result.winner,
        market,
        confidence,
        edge,
        reason: `${result.game.toUpperCase()}: ${result.team1} ${result.score} ${result.team2} — ${result.winner} wins | ${result.event}`,
      });
      break;
    }
  }

  // Oracle arb targets (already near 1.0)
  for (const m of oracleTargets) {
    if (heldIds.includes(m.conditionId)) continue;
    const edge = 1.0 - m.yesPrice;
    signals.push({
      type: 'ORACLE',
      team: '?',
      market: m,
      confidence: 0.97,
      edge,
      reason: `Oracle lag: YES at ${m.yesPrice.toFixed(2)}, ${m.hoursLeft.toFixed(0)}h left`,
    });
  }

  signals.sort((a, b) => b.edge - a.edge);
  console.log(`[esports] ${signals.length} total signals`);

  for (const sig of signals.slice(0, MAX_POSITIONS - open.length)) {
    console.log(`\n[esports] 🎮 ${sig.type}: ${sig.reason}`);
    console.log(`  Market: ${sig.market.question.slice(0, 80)}`);
    console.log(`  Edge: ${(sig.edge*100).toFixed(1)}% | Confidence: ${(sig.confidence*100).toFixed(0)}%`);

    if (!ARMED) {
      console.log(`  [DRY RUN] Would buy YES @ ${sig.market.yesPrice.toFixed(2)}`);
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) { console.log('[esports] Market not accepting orders'); continue; }

      const shares = Math.floor(BET_SIZE_USD / sig.market.yesPrice);
      if (shares < 5) { console.log('[esports] Too few shares'); continue; }

      const orderId = await placeBuy({ tokenId: sig.market.tokenId, price: sig.market.yesPrice, size: BET_SIZE_USD, side: 'YES' });
      addPosition({ conditionId: sig.market.conditionId, question: sig.market.question, side: 'YES', entryPrice: sig.market.yesPrice, shares, cost: BET_SIZE_USD, strategy: 'esports-oracle' });

      const msg = `🎮 Esports ${sig.type}: ${sig.reason} | $${BET_SIZE_USD} @ ${(sig.market.yesPrice*100).toFixed(0)}¢`;
      await tg(msg);
      console.log('[esports] ✅', msg);
    } catch (e: any) {
      console.log('[esports] ❌ Error:', e.message);
    }
  }
}

// ─── Export + standalone ──────────────────────────────────────────────────────

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
