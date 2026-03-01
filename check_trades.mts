import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:15000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

const c = new ClobClient(HOST, CHAIN, wallet, {
  key: process.env.CLOB_API_KEY!,
  secret: process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
} as any, 2, process.env.FUNDER_ADDRESS);

// Get trades to see where money went
try {
  const trades = await (c as any).getTrades({ maker_address: process.env.FUNDER_ADDRESS });
  console.log('Trades:', JSON.stringify(trades).slice(0,500));
} catch(e: any) { console.log('trades err:', e.message?.slice(0,80)); }

// Check open orders
try {
  const orders = await c.getOpenOrders();
  console.log('Open orders:', JSON.stringify(orders).slice(0,300));
} catch(e: any) { console.log('orders err:', e.message?.slice(0,80)); }
