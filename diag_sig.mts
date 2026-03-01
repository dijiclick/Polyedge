import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon',timeout:15000}, 137);
const wallet   = new Wallet(process.env.PRIVATE_KEY!, provider);
const c = new ClobClient('https://clob.polymarket.com', 137, wallet, {
  key:        process.env.CLOB_API_KEY!,
  secret:     process.env.CLOB_SECRET!,
  passphrase: process.env.CLOB_PASSPHRASE!,
} as any, 2, process.env.FUNDER_ADDRESS);

const creds = await c.deriveApiKey(0);
console.log('Derived:', creds.key);
console.log('Env key:', process.env.CLOB_API_KEY);
console.log('Match:', creds.key === process.env.CLOB_API_KEY);
if (creds.key !== process.env.CLOB_API_KEY) {
  console.log('\n⚠️ MISMATCH. New creds:');
  console.log('CLOB_API_KEY=' + creds.key);
  console.log('CLOB_SECRET=' + creds.secret);
  console.log('CLOB_PASSPHRASE=' + creds.passphrase);
}
