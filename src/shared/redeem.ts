/**
 * Auto-redeem won positions on Polymarket CLOB
 * Calls the CLOB redeem endpoint for any settled winning positions
 */


const CLOB_API    = process.env.CLOB_API_URL  || 'https://clob.polymarket.com';
const PROXY_WALLET = process.env.PROXY_WALLET_ADDRESS || '';

export interface RedeemResult {
  conditionId: string;
  usdcReturned: number;
}

/**
 * Redeem all settled winning positions
 * Returns array of redemptions made
 */
export async function redeemWinnings(positions: Array<{ conditionId: string; question: string }>): Promise<RedeemResult[]> {
  const results: RedeemResult[] = [];

  for (const pos of positions) {
    try {
      const res = await fetch(`${CLOB_API}/redeem`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ conditionId: pos.conditionId }),
      });
      if (res.ok) {
        const d: any = await res.json();
        const returned = parseFloat(d?.amount ?? 0);
        if (returned > 0) {
          console.log(`[redeem] ✅ ${pos.question.slice(0, 60)} → +$${returned.toFixed(2)}`);
          results.push({ conditionId: pos.conditionId, usdcReturned: returned });
        }
      }
    } catch (e) {
      // Silent fail — will retry next cycle
    }
  }

  return results;
}

/**
 * Check if a position has resolved as a winner (price = $1.00)
 */
export async function getSettledWinners(positions: Array<{ conditionId: string; tokenId: string; question: string; side: 'YES' | 'NO' }>): Promise<typeof positions> {
  const winners = [];
  for (const pos of positions) {
    try {
      const res = await fetch(`${CLOB_API}/markets/${pos.conditionId}`);
      if (!res.ok) continue;
      const market: any = await res.json();
      // Check if resolved
      if (market.closed === true || market.resolved === true) {
        const winnerToken = market.winner ?? '';
        if (winnerToken && winnerToken === pos.tokenId) {
          winners.push(pos);
        }
      }
    } catch { /* skip */ }
  }
  return winners;
}
