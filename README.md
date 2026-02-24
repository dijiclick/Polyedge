# polyedge

Polymarket AI trading system — two strategies, one runner.

## Strategies

### 1. Oracle Lag Arb
Buys YES tokens when a real-world event has already resolved but Polymarket's oracle hasn't settled yet. The market still shows 90¢ instead of $1.00 — buy the gap.

- Scans expired + near-expiry markets every 10 minutes
- Filters by liquidity, skips government-report markets
- Kelly-sized bets using true probability (0.995 for expired, 0.97 for near-expiry)
- Auto-sells at 98¢ if price moves up before settlement

### 2. Edge AI Predictor
Finds events ending in the next 3 hours, searches the web for current results, and uses AI to predict the outcome. Bets when AI confidence exceeds your risk threshold — even if the market says 50%.

- Filters out noise (5-min automated crypto slots, low liquidity)
- Analyzes top 15 markets by liquidity per cycle
- Learns accuracy per event type (soccer, basketball, elections, crypto...)
- Risk levels: `LOW` (85%+), `MEDIUM` (70%+), `HIGH` (55%+)

## Setup

```bash
npm install
cp .env.example .env
# fill in your credentials
```

## Run

```bash
# Dry run — no real orders
npm run dry

# Live — both strategies
npm run live

# Oracle arb only (live)
npm run oracle:live

# Edge AI only (live, medium risk)
npm run edge:live
```

## Config

| Env var | Default | Description |
|---------|---------|-------------|
| `ARMED` | `false` | Set `true` to place real orders |
| `RISK_LEVEL` | `MEDIUM` | AI confidence threshold (`LOW`/`MEDIUM`/`HIGH`) |
| `MAX_POSITIONS` | `4` | Max open positions per strategy |
| `MAX_BET` | `3.00` | Max $ per single trade |
| `MIN_LIQUIDITY` | `500` | Min $ liquidity to consider a market |
| `SCAN_INTERVAL_MIN` | `10` | Oracle arb scan interval (minutes) |
| `EDGE_SCAN_MIN` | `15` | Edge AI scan interval (minutes) |

## Architecture

```
src/
  runner.ts              ← runs both strategies
  llm.ts                 ← OpenRouter client (DeepSeek V3.2 + web search)
  strategies/
    oracle-arb.ts        ← oracle lag arbitrage
    edge-ai.ts           ← AI-powered near-expiry predictor
  shared/
    clob.ts              ← Polymarket CLOB order execution
    positions.ts         ← position tracking (/tmp/pm-positions.json)
    patterns.ts          ← AI accuracy memory per event type
    kelly.ts             ← Kelly criterion position sizing
    telegram.ts          ← Telegram notifications
```

## Requirements

- Node.js 18+
- Polygon wallet with USDC + MATIC (for gas)
- OpenRouter API key
- Polymarket CLOB API credentials
