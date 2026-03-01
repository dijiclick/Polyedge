import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import crypto from 'crypto';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:15000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

const c = new ClobClient(HOST, CHAIN, wallet, {
  key: process.env.CLOB_API_KEY!,
  secret: process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
} as any, 2, process.env.FUNDER_ADDRESS);

// Get headers for authenticated request
const headers = await (c as any).createL2Headers('GET', '/balance-allowance', { asset_type: '0' });
console.log('L2 headers:', JSON.stringify(headers).slice(0,100));

const params = new URLSearchParams({ asset_type: '0' });
const resp = await fetch(`${HOST}/balance-allowance?${params}`, { headers });
const text = await resp.text();
console.log('Raw response:', text.slice(0,300));
