/**
 * execute-signal.ts
 *
 * Unified signal execution layer.
 * - ARMED=false  → paper-trade only (logs prediction, no real bet)
 * - ARMED=true   → place real bet AND log prediction for tracking
 *
 * All strategies should call executeSignal() instead of calling placeBuy() directly.
 */

import { logPaperTrade, type PaperTrade } from './paper-trader.js';
import { getUsdcBalance, placeBuy, getClobMarket } from './clob.js';
import { addPosition } from './positions.js';
import { tg } from './telegram.js';

const ARMED       = process.env.ARMED === 'true';
const BET_SIZE    = 1;   // $1 cap across all strategies

// Category detector from question text
export function detectCategory(question: string): string {
  const q = question.toLowerCase();
  if (/starmer|uk election|keir/i.test(q))               return 'UK-Politics';
  if (/macron|france|french/i.test(q))                   return 'France';
  if (/ukraine|ceasefire|zelenskyy|russian territory/i.test(q)) return 'Ukraine';
  if (/trump|biden|harris|republican|democrat|congress|senate|house/i.test(q)) return 'US-Politics';
  if (/bitcoin|btc|ethereum|eth|solana|crypto|defi/i.test(q)) return 'Crypto';
  if (/microstrategy|mstr/i.test(q))                     return 'MicroStrategy';
  if (/lck|lpl|league of legends|lol|esport/i.test(q))  return 'Esports-LoL';
  if (/cs2|csgo|counter.strike|blast|valorant/i.test(q)) return 'Esports-CS2';
  if (/nba|nfl|mlb|nhl|soccer|epl|bundesliga|la liga|serie a|ucl|champions league/i.test(q)) return 'Sports';
  if (/golf|pga|masters|us open.*golf|open.*championship/i.test(q)) return 'Golf';
  if (/tennis|wimbledon|french open|roland garros|atp|wta/i.test(q)) return 'Tennis';
  if (/fed |federal reserve|interest rate|rate cut|rate hold/i.test(q)) return 'Macro';
  if (/tariff|trade war/i.test(q))                       return 'Tariffs';
  if (/ipo|initial public/i.test(q))                     return 'IPO';
  if (/oscar|emmy|grammy|bafta|award/i.test(q))          return 'Awards';
  if (/elon|tesla|spacex|doge/i.test(q))                 return 'Elon';
  if (/openai|gpt|claude|gemini|anthropic|ai model/i.test(q)) return 'AI-Tech';
  if (/russia|nato|military|war|invasion/i.test(q))      return 'Geopolitics';
  return 'Other';
}

export interface SignalParams {
  strategy:     string;
  question:     string;
  conditionId:  string;
  tokenId:      string;
  side:         'YES' | 'NO';
  entryPrice:   number;
  confidence:   number;
  edge:         number;
  signalReason: string;
}

export async function executeSignal(params: SignalParams): Promise<boolean> {
  const category = detectCategory(params.question);
  const emoji    = ARMED ? '💰' : '📝';

  console.log(`\n${emoji} [${params.strategy}] ${params.side} @ ${params.entryPrice.toFixed(3)} | conf ${(params.confidence*100).toFixed(0)}% | edge ${(params.edge*100).toFixed(1)}%`);
  console.log(`   Category: ${category}`);
  console.log(`   Market: ${params.question.slice(0, 80)}`);
  console.log(`   Reason: ${params.signalReason}`);

  // Always paper-log (tracks predictions for P&L analysis)
  const paper = logPaperTrade({
    strategy:     params.strategy,
    category,
    question:     params.question,
    conditionId:  params.conditionId,
    side:         params.side,
    entryPrice:   params.entryPrice,
    confidence:   params.confidence,
    edge:         params.edge,
    signalReason: params.signalReason,
  });

  if (!ARMED) {
    console.log(`   [PAPER] Logged as ${paper.id} — no real bet placed`);
    return false;
  }

  // Live execution
  try {
    const usdc = await getUsdcBalance();
    if (usdc < BET_SIZE) {
      console.log(`   [LIVE] Insufficient balance: $${usdc.toFixed(2)}`);
      return false;
    }

    const clob = await getClobMarket(params.conditionId);
    if (!clob?.accepting_orders) {
      console.log(`   [LIVE] Market not accepting orders`);
      return false;
    }

    const shares = Math.floor(BET_SIZE / params.entryPrice);
    if (shares < 5) {
      console.log(`   [LIVE] Too few shares (${shares}), skip`);
      return false;
    }

    await placeBuy({ tokenId: params.tokenId, price: params.entryPrice, size: BET_SIZE, side: params.side });
    addPosition({
      conditionId: params.conditionId,
      question:    params.question,
      side:        params.side,
      entryPrice:  params.entryPrice,
      shares,
      cost:        BET_SIZE,
      strategy:    params.strategy,
    });

    const msg = `${emoji} [${params.strategy}/${category}] ${params.side} ${params.question.slice(0,60)} @ ${params.entryPrice.toFixed(2)} | ${params.signalReason}`;
    await tg(msg);
    console.log(`   [LIVE] ✅ Bet placed: $${BET_SIZE} | ${shares} shares`);
    return true;

  } catch (e: any) {
    console.log(`   [LIVE] ❌ Error: ${e.message}`);
    return false;
  }
}
