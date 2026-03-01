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

// Pass USDC.e address explicitly
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
try {
  const b = await c.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
    token_id: USDC,
  } as any);
  console.log('Balance with token_id:', JSON.stringify(b));
} catch(e: any) { console.log('err:', e.message?.slice(0,80)); }

// Try raw fetch with the proper params
const headers = (c as any).creds;
const resp = await fetch(
  `${HOST}/balance-allowance?asset_type=0&token_id=${USDC}`,
  { headers: {
    'POLY_ADDRESS': process.env.FUNDER_ADDRESS!,
    'POLY_API_KEY': process.env.CLOB_API_KEY!,
    'POLY_PASSPHRASE': process.env.CLOB_PASSPHRASE!,
    'POLY_TIMESTAMP': String(Math.floor(Date.now()/1000)),
    'POLY_SIGNATURE': 'sig',
  }}
);
console.log('Raw status:', resp.status);
console.log('Raw body:', (await resp.text()).slice(0,200));
