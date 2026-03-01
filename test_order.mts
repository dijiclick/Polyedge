import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:20000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const c = new ClobClient(HOST, CHAIN, wallet, {
  key: process.env.CLOB_API_KEY!,
  secret: process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
} as any, 2, process.env.FUNDER_ADDRESS);

// Check balance allowance ALL types
for (const assetType of [0, 1]) {
  try {
    const b = await c.getBalanceAllowance({ asset_type: assetType });
    console.log(`AssetType ${assetType}:`, JSON.stringify(b));
  } catch(e: any) { console.log(`AssetType ${assetType} err:`, e.message?.slice(0,80)); }
}

// Also try to get open orders — if there are any, there must be funds somewhere
try {
  const orders = await c.getOpenOrders();
  console.log('Open orders:', JSON.stringify(orders).slice(0,200));
} catch(e: any) { console.log('Orders err:', e.message?.slice(0,80)); }
