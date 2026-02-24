import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const PRIVATE_KEY     = process.env.PRIVATE_KEY     || '0x3ead940f60ffc959fe2d5f729af82d54de4ee8ec18809810d7c2ab593d9a1cea';
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS  || '0xc92fe1c5f324c58d0be12b8728be18a92375361f';
const CLOB_API_KEY    = process.env.CLOB_API_KEY    || '5f82d234-ef03-3fa5-cfb8-868be813bf54';
const CLOB_SECRET     = process.env.CLOB_SECRET     || 'SjCrhTWgfwbB-QqAzwWmdN1LjIvxiOfI_lSFqg16CYo=';
const CLOB_PASSPHRASE = process.env.CLOB_PASSPHRASE || '0f0457a4a35a228b82224f0910c66fd56d63c59ac53bde0b2e296966006997f6';
export const CLOB_HOST = 'https://clob.polymarket.com';

let _client: ClobClient | null = null;

export async function getClient(): Promise<ClobClient> {
  if (_client) return _client;
  const wallet = new Wallet(PRIVATE_KEY);
  const creds  = { key: CLOB_API_KEY, secret: CLOB_SECRET, passphrase: CLOB_PASSPHRASE };
  // signatureType=2 = GnosisSafe proxy
  _client = new ClobClient(CLOB_HOST, 137, wallet, creds, 2, FUNDER_ADDRESS);
  return _client;
}

export async function getUsdcBalance(): Promise<number> {
  try {
    const c = await getClient();
    const b = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return parseFloat((b as any).balance ?? '0');
  } catch { return 0; }
}

export async function placeBuy(opts: {
  tokenId:    string;
  price:      number;
  usdcAmount: number;
}): Promise<{ orderId: string; shares: number }> {
  const c      = await getClient();
  const shares = opts.usdcAmount / opts.price;
  const order: any = await (c as any).createAndPostOrder({
    tokenID:    opts.tokenId,
    price:      opts.price,
    side:       Side.BUY,
    size:       shares,
    orderType:  OrderType.GTC,
    feeRateBps: 0,
    nonce:      0,
    negRisk:    false,
    tickSize:   '0.01',
  });
  return { orderId: order.orderID ?? order.id ?? 'unknown', shares };
}

export async function placeSell(opts: {
  tokenId: string;
  shares:  number;
  price:   number;
}): Promise<string> {
  const c = await getClient();
  const order: any = await (c as any).createAndPostOrder({
    tokenID:    opts.tokenId,
    price:      opts.price,
    side:       Side.SELL,
    size:       opts.shares,
    orderType:  OrderType.GTC,
    feeRateBps: 0,
    nonce:      0,
    negRisk:    false,
    tickSize:   '0.01',
  });
  return order.orderID ?? order.id ?? 'unknown';
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
