import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon',timeout:15000}, 137);
const wallet   = new Wallet(process.env.PRIVATE_KEY!, provider);
const c = new ClobClient('https://clob.polymarket.com', 137, wallet, {
  key: process.env.CLOB_API_KEY!, secret: process.env.CLOB_SECRET!, passphrase: process.env.CLOB_PASSPHRASE!,
} as any);

const b = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL, token_id: '' } as any);
console.log('Balance:', JSON.stringify(b));
