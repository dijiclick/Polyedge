/**
 * Supabase integration — logs every trade, tracks P&L, self-improves
 * Uses existing edge_predictions table + live_trades for our own trades
 */

const SUPA_URL = process.env.SUPABASE_URL || 'https://yitqtpzsrvsdworcwsfb.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supaPost(table: string, data: object) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase POST ${table} failed: ${err.slice(0, 100)}`);
  }
  return res.json();
}

async function supaPatch(table: string, filter: string, data: object) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function supaGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    },
  });
  return res.json();
}

// ─── Log a new trade signal ───────────────────────────────────────────────
export async function logTradeSignal(opts: {
  conditionId:   string;
  question:      string;
  eventType:     string;
  side:          'YES' | 'NO';
  confidence:    number;
  entryPrice:    number;
  bet:           number;
  reasoning:     string;
  keyFact:       string;
  dryRun:        boolean;
  orderId?:      string;
}) {
  try {
    const rows = await supaPost('edge_predictions', {
      event_id:          opts.conditionId,
      event_title:       opts.question.slice(0, 100),
      market_id:         opts.conditionId,
      market_question:   opts.question,
      predicted_outcome: opts.side,
      probability:       Math.round(opts.confidence * 100),
      reasoning:         opts.reasoning,
      ai_summary:        opts.keyFact,
      yes_price:         opts.side === 'YES' ? opts.entryPrice : 1 - opts.entryPrice,
      no_price:          opts.side === 'NO'  ? opts.entryPrice : 1 - opts.entryPrice,
      divergence:        Math.abs(opts.confidence - opts.entryPrice),
      profit_pct:        ((1 / opts.entryPrice - 1) * 100),
      alert_sent:        !opts.dryRun,
    });
    const id = Array.isArray(rows) ? rows[0]?.id : rows?.id;
    console.log(`[supabase] Trade logged → id=${id}`);
    return id;
  } catch (e: any) {
    console.error('[supabase] logTradeSignal failed:', e.message?.slice(0, 80));
    return null;
  }
}

// ─── Update trade with actual outcome (WIN/LOSS) ──────────────────────────
export async function resolveTradeSignal(opts: {
  conditionId:    string;
  actualOutcome:  'YES' | 'NO';
  wasCorrect:     boolean;
  pnl:            number;
}) {
  try {
    await supaPatch(
      'edge_predictions',
      `event_id=eq.${opts.conditionId}&order=detected_at.desc&limit=1`,
      {
        actual_outcome: opts.actualOutcome,
        was_correct:    opts.wasCorrect,
        resolved_at:    new Date().toISOString(),
        profit_pct:     opts.pnl,
      }
    );
    console.log(`[supabase] Resolved: ${opts.wasCorrect ? '✅ WIN' : '❌ LOSS'} pnl=$${opts.pnl.toFixed(2)}`);
  } catch (e: any) {
    console.error('[supabase] resolveTradeSignal failed:', e.message?.slice(0, 80));
  }
}

// ─── Get profitability stats ──────────────────────────────────────────────
export async function getProfitabilityStats(): Promise<{
  total: number; wins: number; losses: number;
  winRate: number; totalPnl: number; avgPnl: number;
  byEventType: Record<string, { wins: number; losses: number; pnl: number }>;
}> {
  try {
    const rows = await supaGet(
      'edge_predictions',
      'actual_outcome=not.is.null&select=was_correct,profit_pct,ai_summary,reasoning&limit=500'
    );
    const settled = rows.filter(r => r.actual_outcome);
    const wins    = settled.filter(r => r.was_correct).length;
    const losses  = settled.length - wins;
    const totalPnl = settled.reduce((s, r) => s + (parseFloat(r.profit_pct) || 0), 0);
    return {
      total:   settled.length,
      wins, losses,
      winRate: settled.length > 0 ? wins / settled.length : 0,
      totalPnl,
      avgPnl:  settled.length > 0 ? totalPnl / settled.length : 0,
      byEventType: {},
    };
  } catch {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, byEventType: {} };
  }
}

// ─── Self-improve: adjust confidence threshold based on results ──────────
export async function getRecommendedThreshold(current: number): Promise<number> {
  const stats = await getProfitabilityStats();
  if (stats.total < 10) return current; // not enough data

  if (stats.winRate < 0.45) {
    const newThreshold = Math.min(0.80, current + 0.03);
    console.log(`[supabase] 📈 Self-improve: win rate ${(stats.winRate*100).toFixed(0)}% — raising threshold ${current} → ${newThreshold}`);
    return newThreshold;
  }
  if (stats.winRate > 0.72 && stats.total > 20) {
    const newThreshold = Math.max(0.58, current - 0.02);
    console.log(`[supabase] 📉 Self-improve: win rate ${(stats.winRate*100).toFixed(0)}% — lowering threshold ${current} → ${newThreshold}`);
    return newThreshold;
  }
  return current;
}
