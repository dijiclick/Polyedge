import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:15000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

// Try WITHOUT funder (EOA mode)
const c = new ClobClient(HOST, CHAIN, wallet, {
  key: process.env.CLOB_API_KEY!,
  secret: process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
} as any);

const bal = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
console.log('EOA COLLATERAL balance:', JSON.stringify(bal));
