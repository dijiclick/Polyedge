import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:15000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

const creds = {
  key: process.env.CLOB_API_KEY!,
  secret: process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
};
console.log('Using CLOB key:', creds.key?.slice(0,12));
console.log('Funder:', process.env.FUNDER_ADDRESS);

const c = new ClobClient(HOST, CHAIN, wallet, creds as any, 2, process.env.FUNDER_ADDRESS);

// Try deriving fresh API creds
try {
  const derived = await c.deriveApiKey();
  console.log('Derived key:', JSON.stringify(derived).slice(0,80));
} catch(e: any) { console.log('derive err:', e.message?.slice(0,60)); }

// Raw balance check
try {
  const col = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('COLLATERAL balance:', JSON.stringify(col));
} catch(e: any) { console.log('balance err:', e.message?.slice(0,80)); }
