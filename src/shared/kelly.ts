/**
 * Kelly criterion position sizing. Uses 1/4 Kelly to be conservative.
 *
 * IMPORTANT: probability and marketPrice must be different values to produce a non-zero bet.
 *   - oracle-arb:  probability ≈ 0.995 (event already happened), marketPrice = actual YES price
 *   - edge-ai:     probability = AI confidence, marketPrice = current YES/NO price
 *   If probability == marketPrice the formula returns 0 (no edge), defaulting to minBet.
 */
export function kellyBet(opts: {
  probability:   number;   // true win probability (AI estimate or oracle certainty)
  marketPrice?:  number;   // price paid per share (defaults to probability if omitted)
  bankroll:      number;
  minBet?:       number;
  maxBet?:       number;
}): number {
  const { probability: p, bankroll, minBet = 0.50, maxBet = 1.00 } = opts;
  const marketPrice = opts.marketPrice ?? p;
  if (p <= 0 || p >= 1 || marketPrice <= 0 || marketPrice >= 1) return minBet;
  const b      = 1 / marketPrice - 1;               // net profit per $ at this price
  const kelly  = (p * b - (1 - p)) / b;             // full Kelly fraction
  const bet    = Math.max(0, kelly * 0.25) * bankroll; // quarter-Kelly
  return Math.min(Math.max(bet, minBet), maxBet);
}
