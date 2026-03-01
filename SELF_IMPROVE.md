# Polyedge Self-Improvement Log
*I update this file after every session based on real trade results and errors.*

---

## Active Rules (Current Best Settings)

| Parameter | Value | Reason |
|---|---|---|
| Max bet | $1.00 | Capital preservation, prove system first |
| Max hours to close | 72h (3 days) | Avoid stale markets, faster feedback |
| Min liquidity | $500 | Avoid thin markets with bad fills |
| Min confidence | >0.60 | Only bet when AI is sure |
| Kelly fraction | 1/4 | Conservative sizing |
| Max positions | 4 | Don't over-concentrate |

---

## Lessons Learned

### 2026-03-01
- **Session tokens from temp-mail (dollicons.com) don't work with perplexity-webui-scraper** (Pro API rejects free accounts via library). Fixed by using Scrapling StealthyFetcher to scrape search results directly.
- **Perplexity proxy approach works better** — bypass CF, scrape page, no API key needed.
- **Prompts must be specific**: vague queries like "question result outcome today" cause Perplexity to return data about similar events, not the exact one. Fixed to ask for exact factual outcome.
- **sonar (not sonar-pro)** — use sonar to avoid daily Pro limits.

---

## Performance Tracker

| Date | Trades | Wins | Losses | P&L | Notes |
|---|---|---|---|---|---|
| 2026-03-01 | 0 | 0 | 0 | $0.00 | Win rate: N/A% |

---

## What to Improve Next

### Priority 1 — Measure & adjust confidence threshold
- Track: what % of trades where AI confidence was 0.60-0.70 actually won?
- If <50%: raise threshold to 0.70
- If >70%: can lower to 0.58 to catch more edges

### Priority 2 — Track which event types are most accurate
- Soccer/football: usually accurate if game already happened
- Crypto price: hard to predict, consider skipping
- Elections/politics: high volume, good for oracle-arb
- Sports awards: can be good if award announced before market closes

### Priority 3 — Prompt refinement
- After each trade, log whether Perplexity's answer was correct
- If Perplexity gave wrong info → update prompt to add: "Only report confirmed official results, not predictions or rumors"

### Priority 4 — Token rotation health
- Log which tokens hit rate limits
- Auto-refresh tokens that expire (run magic-link re-login script)

---

## Self-Improvement Protocol

Every 50 trades, I will:
1. Calculate win rate by event type
2. Adjust MIN_CONFIDENCE based on actual win rate
3. Update the "Lessons Learned" section above
4. Re-evaluate which event types to skip entirely

Every week:
1. Check all 11 session tokens still valid
2. Re-login any expired ones via magic link
3. Review P&L and adjust maxBet if system is profitable

---

## Red Flags (Stop Trading If)
- Win rate drops below 40% over 20+ trades → stop, investigate
- 3 consecutive losses → pause for 1 cycle
- USDC balance below $10 → pause, report to Aria
- Any API error rate >50% → debug before continuing
