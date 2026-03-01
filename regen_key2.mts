import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const HOST = 'https://clob.polymarket.com';
const CHAIN = 137;
const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon', timeout:20000}, CHAIN);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const c = new ClobClient(HOST, CHAIN, wallet, undefined, 2, process.env.FUNDER_ADDRESS);

// Try nonces 0-5
for (let nonce = 0; nonce < 6; nonce++) {
  try {
    const derived = await (c as any).deriveApiKey(nonce);
    console.log(`nonce ${nonce}:`, JSON.stringify(derived));
    // Test this key
    const testClient = new ClobClient(HOST, CHAIN, wallet, derived, 2, process.env.FUNDER_ADDRESS);
    const bal = await testClient.getBalanceAllowance({ asset_type: 0 });
    const b = parseFloat((bal as any).balance ?? '0');
    console.log(`  → balance: $${b}`);
    if (b > 0) {
      console.log(`\n✅ FOUND FUNDS! nonce=${nonce}, balance=$${b}`);
      console.log('KEY:', derived.key);
      console.log('SECRET:', derived.secret);
      console.log('PASSPHRASE:', derived.passphrase);
      break;
    }
  } catch(e: any) { console.log(`nonce ${nonce} err:`, e.message?.slice(0,50)); }
}
