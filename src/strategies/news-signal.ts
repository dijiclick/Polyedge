/**
 * News Signal Strategy
 *
 * Monitors free RSS feeds (Reuters, AP, Guardian) for breaking news.
 * When a headline matches a Polymarket question, fires a YES/NO bet
 * within minutes — before the crowd reprices the market.
 *
 * Signal types:
 *  - "Trump signs X" / "Congress passes X" → YES on related market
 *  - "X fails", "vetoed", "rejected" → NO signal
 *  - Score/result confirmations → YES on match markets
 *
 * Run: ARMED=true npx tsx src/strategies/news-signal.ts --monitor
 */

import { tg } from '../shared/telegram.js';
import { getUsdcBalance, placeBuy, getClobMarket } from '../shared/clob.js';
import { logPaperTrade } from '../shared/paper-trader.js';
import { detectCategory } from '../shared/execute-signal.js';
import { addPosition, getOpenPositions } from '../shared/positions.js';
import { spawnSync } from 'child_process';

const ARMED         = process.env.ARMED === 'true';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '8');
const SCAN_INTERVAL = 5 * 60_000;  // 5 min
const GAMMA_HOST    = 'https://gamma-api.polymarket.com';
const BET_SIZE_USD  = 1;

// ─── RSS Feeds ────────────────────────────────────────────────────────────────

const FEEDS = [
  // Guardian
  { name: 'Guardian US',     url: 'https://www.theguardian.com/us-news/rss' },
  { name: 'Guardian Business', url: 'https://www.theguardian.com/business/rss' },
  { name: 'Guardian World',  url: 'https://www.theguardian.com/world/rss' },
  { name: 'Guardian Trump',  url: 'https://www.theguardian.com/us-news/trump-administration/rss' },
  { name: 'Guardian Middle East', url: 'https://www.theguardian.com/world/middleeast/rss' },
  // Politico
  { name: 'Politico',        url: 'https://rss.politico.com/politics-news.xml' },
  // BBC
  { name: 'BBC World',       url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: 'BBC US/Canada',   url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml' },
  // AP News (free, reliable)
  { name: 'AP World',        url: 'https://rsshub.app/apnews/topics/world-news' },
];

// ─── Signal Rules ─────────────────────────────────────────────────────────────

interface SignalRule {
  headline:  RegExp;   // matches news headline
  market:    RegExp;   // matches Polymarket question
  side:      'YES' | 'NO';
  confidence: number;
  tag:       string;   // human-readable label
}

const SIGNAL_RULES: SignalRule[] = [
  // Trump executive actions
  {
    headline:   /trump.{0,40}(signs?|signed|executive order|enacted|approved)/i,
    market:     /will trump (sign|issue|enact|approve)/i,
    side:       'YES', confidence: 0.90,
    tag:        'Trump signs EO',
  },
  {
    headline:   /trump.{0,40}(vetoes?|vetoed|rejects?|rejected|refused)/i,
    market:     /will trump (sign|approve|pass)/i,
    side:       'NO', confidence: 0.88,
    tag:        'Trump vetoes/rejects',
  },
  // Congress / legislation
  {
    headline:   /(congress|senate|house).{0,50}(passes?|passed|approves?|approved)/i,
    market:     /will (congress|senate|house).{0,50}(pass|approve)/i,
    side:       'YES', confidence: 0.88,
    tag:        'Congress passes bill',
  },
  {
    headline:   /(congress|senate|house).{0,50}(fails?|failed|blocks?|blocked|rejected)/i,
    market:     /will (congress|senate|house).{0,50}(pass|approve)/i,
    side:       'NO', confidence: 0.85,
    tag:        'Congress fails/blocks bill',
  },
  // Fed / interest rates
  {
    headline:   /fed(eral reserve)?.{0,40}(raises?|raised|hikes?|hiked) (rates?|interest)/i,
    market:     /will (the )?fed.{0,40}(raise|hike|increase).{0,20}rate/i,
    side:       'YES', confidence: 0.92,
    tag:        'Fed raises rates',
  },
  {
    headline:   /fed(eral reserve)?.{0,40}(cuts?|cut|lowers?|lowered) (rates?|interest)/i,
    market:     /will (the )?fed.{0,40}(cut|lower|reduce).{0,20}rate/i,
    side:       'YES', confidence: 0.92,
    tag:        'Fed cuts rates',
  },
  // Tariffs / trade
  {
    headline:   /trump.{0,60}(tariff|tariffs).{0,40}(imposes?|imposed|announces?|announced)/i,
    market:     /will trump.{0,60}tariff/i,
    side:       'YES', confidence: 0.87,
    tag:        'Trump imposes tariffs',
  },
  // Ukraine / Russia / ceasefire
  {
    headline:   /(ceasefire|cease.fire).{0,60}(ukraine|russia)/i,
    market:     /will.{0,40}(ceasefire|cease.fire).{0,40}(ukraine|russia)/i,
    side:       'YES', confidence: 0.85,
    tag:        'Ceasefire Ukraine',
  },
  // Elections
  {
    headline:   /(\w[\w\s]{3,30}) (wins?|won|elected|declared winner).{0,40}(election|vote|race|primary)/i,
    market:     /will \w+.{0,40}win.{0,40}(election|primary|race)/i,
    side:       'YES', confidence: 0.88,
    tag:        'Election winner declared',
  },
  // Crypto ETF
  {
    headline:   /sec.{0,40}(approves?|approved).{0,40}(bitcoin|ethereum|crypto).{0,40}etf/i,
    market:     /will (sec|u\.?s\.?).{0,40}(approve|launch).{0,40}(bitcoin|ethereum|crypto).{0,40}etf/i,
    side:       'YES', confidence: 0.90,
    tag:        'SEC approves crypto ETF',
  },
  // AI model releases
  {
    headline:   /(openai|anthropic|google|meta|mistral|deepseek|xai).{0,50}(releases?|released|launches?|launched|announces?|announced).{0,50}(model|ai|gpt|claude|gemini|llama|grok)/i,
    market:     /will (openai|anthropic|google|meta|mistral|deepseek|xai).{0,50}(release|launch).{0,50}(model|gpt|claude|gemini|llama|grok)/i,
    side:       'YES', confidence: 0.88,
    tag:        'AI model release',
  },
  // GPT-5 / Claude 4 / Gemini 2 specific
  {
    headline:   /(gpt-?5|gpt5|claude.?4|claude.?opus|gemini.?2|gemini.?ultra|llama.?4|grok.?3)/i,
    market:     /(gpt-?5|gpt5|claude.?4|claude.?opus|gemini.?2|gemini.?ultra|llama.?4|grok.?3)/i,
    side:       'YES', confidence: 0.90,
    tag:        'Major AI model announced',
  },
  // AI regulation / ban
  {
    headline:   /(eu|europe|congress|senate).{0,60}(bans?|banned|regulates?|regulated|restricts?|restricted).{0,40}(ai|artificial intelligence)/i,
    market:     /will.{0,60}(ban|regulate|restrict).{0,40}(ai|artificial intelligence)/i,
    side:       'YES', confidence: 0.85,
    tag:        'AI regulation',
  },
  // Elon Musk / Tesla / SpaceX
  {
    headline:   /elon musk.{0,60}(resigns?|resigned|fired|leaves?|left|steps? down).{0,40}(doge|government|tesla|spacex|white house)/i,
    market:     /will elon musk.{0,60}(resign|leave|step down|be fired|be removed)/i,
    side:       'YES', confidence: 0.87,
    tag:        'Elon Musk leaves role',
  },
  {
    headline:   /tesla.{0,60}(recalls?|recall|crash|accident|autopilot|fsd).{0,60}(investigation|probe|fine|penalty)/i,
    market:     /will tesla.{0,60}(recall|face|pay|settle)/i,
    side:       'YES', confidence: 0.82,
    tag:        'Tesla recall/investigation',
  },
  // Crypto price milestones
  {
    headline:   /bitcoin.{0,30}(hits?|hit|reaches?|reached|surpasses?|surpassed|crosses?|crossed).{0,30}\$([\d,]+)/i,
    market:     /will bitcoin.{0,30}(reach|hit|exceed|surpass).{0,30}\$([\d,]+)/i,
    side:       'YES', confidence: 0.88,
    tag:        'Bitcoin price milestone',
  },
  // Sports championships (as backup for oracle-arb)
  {
    headline:   /(\w[\w\s]{2,25}) (wins?|won|defeats?|defeated|claims?|claimed).{0,40}(championship|title|cup|series|super bowl|nba finals|stanley cup|world series)/i,
    market:     /will \w[\w\s]{2,25} win.{0,40}(championship|title|cup|series|super bowl|nba finals|stanley cup|world series)/i,
    side:       'YES', confidence: 0.92,
    tag:        'Championship winner confirmed',
  },
  // Drug/FDA approvals
  {
    headline:   /fda.{0,60}(approves?|approved).{0,60}(drug|treatment|vaccine|therapy)/i,
    market:     /will fda.{0,60}(approve|clear).{0,60}(drug|treatment|vaccine|therapy)/i,
    side:       'YES', confidence: 0.88,
    tag:        'FDA drug approval',
  },
  // === HIGH-VALUE NEW RULES (2026-03-03) ===
  // Starmer resigns / no-confidence vote
  {
    headline:   /starmer.{0,80}(resigns?|resigned|fired|no.confidence|steps? down|ousted|removed|leadership challenge)/i,
    market:     /starmer.{0,50}(out|resign|leave|step down|removed)/i,
    side:       'YES', confidence: 0.91,
    tag:        'Starmer out',
  },
  // Macron resigns / snap election called
  {
    headline:   /macron.{0,80}(resigns?|resigned|snap election|dissolution|no.confidence|steps? down|steps down)/i,
    market:     /macron.{0,50}(out|resign|leave|step down|election)/i,
    side:       'YES', confidence: 0.91,
    tag:        'Macron out / France election',
  },
  // Ukraine ceasefire / peace deal signed
  {
    headline:   /(ukraine|russia|zelensky|putin).{0,80}(ceasefire|cease.fire|peace deal|peace agreement|signed|truce|armistice)/i,
    market:     /(russia|ukraine).{0,60}(ceasefire|cease.fire|peace|truce)/i,
    side:       'YES', confidence: 0.88,
    tag:        'Ukraine ceasefire / peace deal',
  },
  // Ukraine territory cession
  {
    headline:   /ukraine.{0,80}(cedes?|ceded|agrees? to cede|gives? up|concedes?|surrender|transfers?).{0,60}(territory|land|region|oblast)/i,
    market:     /ukraine.{0,60}(cede|territory|russian sovereignty)/i,
    side:       'YES', confidence: 0.87,
    tag:        'Ukraine territory cession',
  },
  // Russia invades NATO country
  {
    headline:   /russia.{0,60}(invades?|invaded|attacks?|troops|military).{0,60}(nato|poland|estonia|latvia|lithuania|finland)/i,
    market:     /russia.{0,60}(invade|nato|poland|baltic)/i,
    side:       'YES', confidence: 0.92,
    tag:        'Russia NATO invasion',
  },
  // Fed rate cut decision
  {
    headline:   /federal reserve.{0,60}(cuts?|cut|reduced?|lowered?|rate cut).{0,40}interest rate/i,
    market:     /fed.{0,50}(rate cut|cut rate|lower rate|reduce rate)/i,
    side:       'YES', confidence: 0.87,
    tag:        'Fed rate cut',
  },
  // Fed rate hold
  {
    headline:   /federal reserve.{0,60}(holds?|held|pauses?|paused|keeps?|keeps? rates?).{0,40}(rate|rates?)/i,
    market:     /fed.{0,50}(hold|pause|no cut|unchanged)/i,
    side:       'YES', confidence: 0.85,
    tag:        'Fed rate hold',
  },
  // Trump tariffs on China increase
  {
    headline:   /trump.{0,60}(raises?|raised|increases?|increased|hikes?|hiked).{0,40}(tariff|tariffs).{0,40}china/i,
    market:     /tariff.{0,50}china/i,
    side:       'YES', confidence: 0.85,
    tag:        'Trump tariff increase on China',
  },
  // IPO launches (Kraken, Discord, Fannie Mae)
  {
    headline:   /(kraken|discord|fannie mae|stripe).{0,80}(ipo|initial public offering|goes public|listed on)/i,
    market:     /(kraken|discord|fannie mae|stripe).{0,50}ipo/i,
    side:       'YES', confidence: 0.90,
    tag:        'Major IPO launches',
  },
  // MicroStrategy sells Bitcoin
  {
    headline:   /microstrategy.{0,80}(sells?|sold|offloads?|offloaded|liquidates?|reduces?).{0,60}bitcoin/i,
    market:     /microstrategy.{0,50}(sell|sells|sold).{0,50}bitcoin/i,
    side:       'YES', confidence: 0.93,
    tag:        'MicroStrategy sells Bitcoin',
  },
  // Measles outbreak / CDC warning  
  {
    headline:   /(measles|bird flu|mpox|h5n1).{0,80}(outbreak|epidemic|cases|cdc|who|declared|emergency|spreading)/i,
    market:     /(measles|bird flu|mpox|pandemic|cdc.{0,20}level).{0,60}(cases|warning|level|emergency)/i,
    side:       'YES', confidence: 0.85,
    tag:        'Disease outbreak / CDC warning',
  },
  // Elon no longer trillionaire (Tesla crashes)
  {
    headline:   /elon musk.{0,60}(no longer|not a|loses? billionaire|drops? out of trillionaire)/i,
    market:     /elon musk.{0,50}trillionaire/i,
    side:       'NO', confidence: 0.85,
    tag:        'Elon loses trillionaire status',
  },
  // === GEOPOLITICS / IRAN / MIDDLE EAST (2026-03-03 breaking news) ===
  // US/Israel strikes Iran
  {
    headline:   /(us|united states|american|israel|israeli).{0,80}(strikes?|struck|bombs?|bombed|attacks?|attacked|missiles?).{0,60}iran/i,
    market:     /(us|israel|trump).{0,60}(strike|attack|bomb|military action).{0,60}iran/i,
    side:       'YES', confidence: 0.93,
    tag:        'US/Israel strikes Iran',
  },
  // Iran retaliates / counter-strikes
  {
    headline:   /iran.{0,80}(retaliates?|retaliation|strikes?|fires?|launches?|missiles?|response).{0,60}(israel|us|saudi|uae|gulf|dubai|strait|hormuz)/i,
    market:     /iran.{0,60}(retaliate|strike|attack|fire|launch)/i,
    side:       'YES', confidence: 0.90,
    tag:        'Iran retaliates / counter-strikes',
  },
  // Khamenei removed / killed / captured
  {
    headline:   /khamenei.{0,80}(killed|dead|removed|ousted|stepped down|captured|detained|fled)/i,
    market:     /khamenei.{0,60}(out|removed|dead|killed|resign)/i,
    side:       'YES', confidence: 0.95,
    tag:        'Khamenei removed/killed',
  },
  // Strait of Hormuz closure / oil supply disruption
  {
    headline:   /(strait of hormuz|hormuz|oil supply|persian gulf).{0,80}(closed|blocked|disrupted|suspended|halted)/i,
    market:     /(hormuz|oil|iran|gulf).{0,60}(close|block|disrupt|suspend)/i,
    side:       'YES', confidence: 0.89,
    tag:        'Strait of Hormuz disruption',
  },
  // Dubai / UAE attacked / safe haven shattered
  {
    headline:   /(dubai|uae|abu dhabi).{0,80}(attack|struck|missile|explosion|disrupted|evacuated|unsafe|shattered)/i,
    market:     /(dubai|uae).{0,60}(attack|safe|stable|disrupted)/i,
    side:       'YES', confidence: 0.88,
    tag:        'Dubai/UAE attacked or destabilized',
  },
  // Ceasefire / peace talks Middle East
  {
    headline:   /(ceasefire|peace talks|truce|peace deal).{0,80}(iran|israel|gaza|lebanon|hezbollah|hamas)/i,
    market:     /(ceasefire|truce|peace).{0,60}(iran|israel|gaza|middle east)/i,
    side:       'YES', confidence: 0.87,
    tag:        'Middle East ceasefire / peace talks',
  },
  // Oil price spike from Middle East conflict
  {
    headline:   /(oil|crude|brent|wti).{0,80}(surges?|spikes?|jumps?|soars?|rises? sharply).{0,40}(iran|middle east|war|conflict|hormuz)/i,
    market:     /(oil|crude|brent).{0,50}(price|per barrel)/i,
    side:       'YES', confidence: 0.82,
    tag:        'Oil price spike from ME conflict',
  },
  // Texas primary results (happening today March 3)
  {
    headline:   /(paxton|cornyn|crockett|talarico).{0,80}(wins?|won|defeats?|defeated|advances?|leads?|projected)/i,
    market:     /(paxton|cornyn|crockett|talarico).{0,60}(win|senate|primary|nominee)/i,
    side:       'YES', confidence: 0.91,
    tag:        'Texas Senate Primary result',
  },
];

// ─── Seen headlines cache (prevent duplicate bets) ────────────────────────────

const seenHeadlines = new Set<string>();

// ─── Fetch RSS ────────────────────────────────────────────────────────────────

interface NewsItem {
  title:   string;
  link:    string;
  pubDate: Date;
  source:  string;
}

function winCurl(url: string, timeoutSec = 20): string | null {
  const r = spawnSync(
    '/mnt/c/Windows/System32/curl.exe',
    ['-s', '--max-time', String(timeoutSec), '-L', url],
    { encoding: 'utf8', timeout: (timeoutSec + 5) * 1000, maxBuffer: 10 * 1024 * 1024 }
  );
  if (r.error) { console.log('[news] curl error:', r.error.message); return null; }
  if (r.status !== 0) { console.log('[news] curl non-zero:', r.status, r.stderr?.slice(0,80)); return null; }
  return r.stdout?.length > 50 ? r.stdout : null;
}

function parseRSS(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const titleM = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i);
    const linkM  = block.match(/<link[^>]*>(.*?)<\/link>/i);
    const dateM  = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/i);
    const title  = (titleM?.[1] ?? titleM?.[2] ?? '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const link   = (linkM?.[1] ?? '').trim();
    const pub    = dateM?.[1] ? new Date(dateM[1]) : new Date();
    if (!title) continue;
    // Only items from last 30 min
    if (Date.now() - pub.getTime() > 30 * 60 * 1000) continue;
    items.push({ title, link, pubDate: pub, source });
  }
  return items;
}

async function fetchAllNews(): Promise<NewsItem[]> {
  const all: NewsItem[] = [];
  for (const feed of FEEDS) {
    const xml = winCurl(feed.url);
    if (!xml) { console.log(`[news] Feed failed: ${feed.name}`); continue; }
    const items = parseRSS(xml, feed.name);
    all.push(...items);
  }
  // Deduplicate by title
  const seen = new Set<string>();
  return all.filter(i => {
    if (seen.has(i.title)) return false;
    seen.add(i.title);
    return true;
  });
}

// ─── Match news to Polymarket questions ──────────────────────────────────────

interface NewsSignal {
  item:        NewsItem;
  market:      any;
  side:        'YES' | 'NO';
  confidence:  number;
  yesPrice:    number;
  tokenId:     string;
  tag:         string;
  edge:        number;
}

async function findSignals(news: NewsItem[]): Promise<NewsSignal[]> {
  if (news.length === 0) return [];

  // Fetch active Polymarket markets via winCurl (avoids WSL TLS)
  let markets: any[] = [];
  try {
    const raw = winCurl(`${GAMMA_HOST}/markets?limit=500&active=true&closed=false`);
    if (!raw) throw new Error('empty response');
    markets = JSON.parse(raw);
  } catch (e: any) {
    console.log('[news] Market fetch error:', e.message);
    return [];
  }

  const signals: NewsSignal[] = [];

  for (const item of news) {
    if (seenHeadlines.has(item.title)) continue;

    for (const rule of SIGNAL_RULES) {
      if (!rule.headline.test(item.title)) continue;

      // Find matching Polymarket market
      for (const m of markets) {
        const q = m.question ?? '';
        if (!rule.market.test(q)) continue;

        const prices   = JSON.parse(m.outcomePrices ?? '[]');
        const yesPrice = parseFloat(prices[0]);
        if (isNaN(yesPrice) || yesPrice <= 0) continue;

        const liq = parseFloat(m.liquidityNum ?? m.liquidity ?? '0');
        if (liq < 200) continue;

        const tokens  = JSON.parse(m.tokens ?? m.clobTokenIds ?? '[]');
        const tokenId = tokens[0] ?? '';

        // Edge: confidence vs current market price
        const effectivePrice = rule.side === 'YES' ? yesPrice : 1 - yesPrice;
        const edge = rule.confidence - effectivePrice;
        if (edge < 0.05) continue;  // at least 5% edge

        signals.push({
          item, market: m, side: rule.side,
          confidence: rule.confidence,
          yesPrice, tokenId, tag: rule.tag, edge,
        });
        break; // one market match per rule per headline
      }
    }
  }

  return signals.sort((a, b) => b.edge - a.edge);
}

// ─── Main scan cycle ──────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const open = getOpenPositions().filter(p => p.strategy === 'news-signal');
  if (open.length >= MAX_POSITIONS) {
    console.log(`[news] At max positions (${open.length}/${MAX_POSITIONS})`);
    return;
  }

  console.log('[news] Fetching RSS feeds...');
  const news = await fetchAllNews();
  const fresh = news.filter(n => !seenHeadlines.has(n.title));
  console.log(`[news] ${news.length} recent headlines (${fresh.length} new)`);

  if (fresh.length === 0) return;

  const signals = await findSignals(fresh);
  console.log(`[news] ${signals.length} signals found`);

  // Check volume spikes
  await checkVolumeSpikes();

  const heldIds = open.map(p => p.conditionId);

  for (const sig of signals) {
    if (open.length + (signals.indexOf(sig)) >= MAX_POSITIONS) break;
    if (heldIds.includes(sig.market.conditionId)) continue;

    seenHeadlines.add(sig.item.title);

    console.log(`\n[news] 📰 ${sig.tag}`);
    console.log(`  Headline: "${sig.item.title.slice(0, 100)}"`);
    console.log(`  Market:   "${sig.market.question?.slice(0, 80)}"`);
    console.log(`  Side: ${sig.side} | Confidence: ${(sig.confidence*100).toFixed(0)}% | Market: ${(sig.yesPrice*100).toFixed(0)}¢ | Edge: ${(sig.edge*100).toFixed(1)}%`);

    if (!ARMED) {
      logPaperTrade({
        strategy: 'news-signal', category: detectCategory(sig.market.question),
        question: sig.market.question, conditionId: sig.market.conditionId,
        side: sig.side, entryPrice: sig.side === 'YES' ? sig.yesPrice : 1 - sig.yesPrice,
        confidence: sig.confidence, edge: sig.edge,
        signalReason: `[${sig.tag}] "${sig.item.title.slice(0, 80)}"`,
      });
      continue;
    }

    try {
      const clob = await getClobMarket(sig.market.conditionId);
      if (!clob?.accepting_orders) { console.log('[news] Market not accepting orders'); continue; }

      const price  = sig.side === 'YES' ? sig.yesPrice : 1 - sig.yesPrice;
      const shares = Math.floor(BET_SIZE_USD / price);
      if (shares < 5) { console.log('[news] Too few shares, skip'); continue; }

      const orderId = await placeBuy({
        tokenId:  sig.tokenId,
        price,
        size:     BET_SIZE_USD,
        side:     sig.side,
      });

      addPosition({
        conditionId: sig.market.conditionId,
        question:    sig.market.question,
        side:        sig.side,
        entryPrice:  price,
        shares,
        cost:        BET_SIZE_USD,
        strategy:    'news-signal',
      });

      const msg = `📰 News signal [${sig.tag}]: "${sig.item.title.slice(0,80)}" → ${sig.side} $${BET_SIZE_USD} on "${sig.market.question?.slice(0,60)}" | edge ${(sig.edge*100).toFixed(1)}%`;
      await tg(msg);
      console.log('[news] ✅', msg);
    } catch (e: any) {
      console.log('[news] ❌ Order error:', e.message);
      await tg(`❌ News signal order failed: ${e.message}`);
    }
  }

  // Trim seen set to avoid unbounded growth
  if (seenHeadlines.size > 5000) {
    const arr = [...seenHeadlines];
    arr.slice(0, 2500).forEach(h => seenHeadlines.delete(h));
  }
}

// ─── Volume Spike Detection ──────────────────────────────────────────────

async function checkVolumeSpikes(): Promise<void> {
  console.log('[news] Checking volume spikes...');
  try {
    const raw = winCurl('https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&order=volume24hr&ascending=false');
    if (!raw) { console.log('[news] Volume spike fetch failed'); return; }
    const markets = JSON.parse(raw) as any[];

    let spikeCount = 0;
    for (const m of markets) {
      const vol = parseFloat(m.volume24hr ?? '0');
      if (vol <= 50000) continue;

      const prices = JSON.parse(m.outcomePrices ?? '[]');
      const yesPrice = parseFloat(prices[0] ?? '0');
      if (yesPrice < 0.30 || yesPrice > 0.70) continue;

      spikeCount++;
      console.log(`[news] 📊 VOLUME SPIKE: ${m.question?.slice(0, 80)}`);
      console.log(`  Vol24h: $${(vol / 1000).toFixed(0)}k | YES: ${(yesPrice * 100).toFixed(0)}¢ | Liq: $${parseFloat(m.liquidityNum ?? m.liquidity ?? '0').toFixed(0)}`);
    }
    console.log(`[news] ${spikeCount} volume spike signals detected`);
  } catch (e: any) {
    console.log('[news] Volume spike check error:', e.message);
  }
}

// ─── Export for runner ────────────────────────────────────────────────────────

export async function runNewsSignal(): Promise<void> {
  const monitor = process.argv.includes('--monitor');
  console.log(`[news] Starting news signal strategy | ARMED=${ARMED} | monitor=${monitor}`);

  await runCycle();

  if (monitor) {
    setInterval(runCycle, SCAN_INTERVAL);
    console.log(`[news] Scanning every ${SCAN_INTERVAL / 60000} min`);
    await new Promise(() => {});
  }
}

// ─── Standalone entry ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('news-signal.ts') || process.argv[1]?.endsWith('news-signal.js')) {
  runNewsSignal().catch(console.error);
}
