import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:20000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

// Create client WITHOUT creds first (to derive new ones)
const c = new ClobClient(HOST, CHAIN, wallet, undefined, 2, process.env.FUNDER_ADDRESS);

try {
  const newCreds = await c.createApiKey(0);  // nonce 0
  console.log('NEW CREDS:', JSON.stringify(newCreds, null, 2));
} catch(e: any) {
  console.log('createApiKey err:', e.message);
  // Try derive instead
  try {
    const derived = await (c as any).deriveApiKey(0);
    console.log('DERIVED:', JSON.stringify(derived, null, 2));
  } catch(e2: any) {
    console.log('derive err:', e2.message?.slice(0,100));
  }
}
