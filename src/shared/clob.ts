/**
 * Polymarket CLOB client
 *
 * signatureType=2 (GnosisSafe proxy wallet)
 *   - Gasless: trades routed through Polymarket's relayer, no POL needed
 *   - Requires proxy wallet deployed (one-time polymarket.com login)
 *   - Funds held in FUNDER_ADDRESS (proxy), not EOA
 *
 * Setup (one-time):
 *   1. Log in at polymarket.com with your wallet → deploys proxy contract
 *   2. Deposit USDC.e to FUNDER_ADDRESS on Polygon
 *   3. Set env vars and run — no gas needed
 */

import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const PRIVATE_KEY     = process.env.PRIVATE_KEY     || '';
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS  || '';
const CLOB_API_KEY    = process.env.CLOB_API_KEY    || '';
const CLOB_SECRET     = process.env.CLOB_SECRET     || '';
const CLOB_PASSPHRASE = process.env.CLOB_PASSPHRASE || '';
export const CLOB_HOST = 'https://clob.polymarket.com';

if (!PRIVATE_KEY || !FUNDER_ADDRESS) {
  console.warn('[clob] WARNING: PRIVATE_KEY or FUNDER_ADDRESS not set in env');
}

let _client: ClobClient | null = null;

export async function getClient(): Promise<ClobClient> {
  if (_client) return _client;

  const wallet = new Wallet(PRIVATE_KEY);
  let creds = { key: CLOB_API_KEY, secret: CLOB_SECRET, passphrase: CLOB_PASSPHRASE };

  // If no API creds in env, auto-derive them from wallet signature
  if (!CLOB_API_KEY) {
    console.log('[clob] No API key in env — deriving from wallet...');
    const temp = new ClobClient(CLOB_HOST, 137, wallet);
    creds = await temp.createOrDeriveApiKey() as any;
    console.log('[clob] API key derived:', (creds as any).key?.slice(0, 8) + '...');
  }

  // signatureType=2 = GnosisSafe proxy wallet (gasless)
  _client = new ClobClient(CLOB_HOST, 137, wallet, creds, 2, FUNDER_ADDRESS);
  return _client;
}

export async function getUsdcBalance(): Promise<number> {
  try {
    const c = await getClient();
    const b = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balance = parseFloat((b as any).balance ?? '0');
    console.log(`[clob] USDC.e balance: $${balance.toFixed(2)}`);
    return balance;
  } catch (e: any) {
    console.error('[clob] balance error:', e.message);
    return 0;
  }
}

// Cache tickSize + negRisk per conditionId to avoid repeated calls
const _marketMeta: Map<string, { tickSize: string; negRisk: boolean }> = new Map();

async function getMarketMeta(conditionId: string): Promise<{ tickSize: string; negRisk: boolean }> {
  if (_marketMeta.has(conditionId)) return _marketMeta.get(conditionId)!;
  try {
    const c = await getClient();
    const tickSize = await c.getTickSize(conditionId);
    const negRisk  = await c.getNegRisk(conditionId);
    const meta     = { tickSize: tickSize as string, negRisk };
    _marketMeta.set(conditionId, meta);
    return meta;
  } catch {
    return { tickSize: '0.01', negRisk: false };  // safe defaults
  }
}

export async function placeBuy(opts: {
  tokenId:      string;
  conditionId?: string;   // used to look up tickSize/negRisk
  price:        number;
  usdcAmount:   number;
}): Promise<{ orderId: string; shares: number }> {
  const c      = await getClient();
  const shares = parseFloat((opts.usdcAmount / opts.price).toFixed(4));

  // Look up correct tickSize and negRisk for this market
  const meta = opts.conditionId
    ? await getMarketMeta(opts.conditionId)
    : { tickSize: '0.01', negRisk: false };

  console.log(`[clob] BUY ${shares.toFixed(4)} shares @ ${opts.price} | tickSize=${meta.tickSize} negRisk=${meta.negRisk} | spend=$${opts.usdcAmount.toFixed(2)}`);

  // Correct SDK signature: createAndPostOrder(orderArgs, options, orderType)
  const order: any = await c.createAndPostOrder(
    {
      tokenID: opts.tokenId,
      price:   opts.price,
      size:    shares,
      side:    Side.BUY,
    },
    {
      tickSize: meta.tickSize as any,
      negRisk:  meta.negRisk,
    },
    OrderType.GTC,
  );

  const orderId = order.orderID ?? order.id ?? 'unknown';
  console.log(`[clob] Order placed: ${orderId} | status: ${order.status}`);
  return { orderId, shares };
}

export async function placeSell(opts: {
  tokenId:      string;
  conditionId?: string;
  shares:       number;
  price:        number;
}): Promise<string> {
  const c    = await getClient();
  const meta = opts.conditionId
    ? await getMarketMeta(opts.conditionId)
    : { tickSize: '0.01', negRisk: false };

  console.log(`[clob] SELL ${opts.shares.toFixed(4)} shares @ ${opts.price}`);

  const order: any = await c.createAndPostOrder(
    {
      tokenID: opts.tokenId,
      price:   opts.price,
      size:    opts.shares,
      side:    Side.SELL,
    },
    {
      tickSize: meta.tickSize as any,
      negRisk:  meta.negRisk,
    },
    OrderType.GTC,
  );

  const orderId = order.orderID ?? order.id ?? 'unknown';
  console.log(`[clob] Sell order: ${orderId}`);
  return orderId;
}

export async function getClobMarket(conditionId: string): Promise<any> {
  const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`CLOB ${res.status} for ${conditionId}`);
  return res.json();
}

export async function getTokenPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number> {
  try {
    const res  = await fetch(`${CLOB_HOST}/price?token_id=${tokenId}&side=${side}`);
    const data: any = await res.json();
    return parseFloat(data.price ?? '0');
  } catch { return 0; }
}

/** Check all open orders — useful to see what's live */
export async function getOpenOrders(): Promise<any[]> {
  try {
    const c = await getClient();
    return await c.getOpenOrders() as any[];
  } catch { return []; }
}

/** Cancel all open orders */
export async function cancelAllOrders(): Promise<void> {
  try {
    const c = await getClient();
    await c.cancelAll();
    console.log('[clob] All orders cancelled');
  } catch (e: any) {
    console.error('[clob] cancelAll error:', e.message);
  }
}
