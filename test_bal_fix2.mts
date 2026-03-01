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

// Pass empty token_id  
const b = await c.getBalanceAllowance({
  asset_type: AssetType.COLLATERAL,
  token_id: '',
} as any);
console.log('Balance:', JSON.stringify(b));
