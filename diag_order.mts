import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon',timeout:15000}, 137);
const wallet   = new Wallet(process.env.PRIVATE_KEY!, provider);

console.log('EOA (signer):', wallet.address);
console.log('FUNDER (proxy maker):', process.env.FUNDER_ADDRESS);
console.log('POLYMARKET_ADDRESS:', process.env.POLYMARKET_ADDRESS);

// Try with FUNDER = proxy wallet (original setup)
const c = new ClobClient('https://clob.polymarket.com', 137, wallet, {
  key: process.env.CLOB_API_KEY!, secret: process.env.CLOB_SECRET!, passphrase: process.env.CLOB_PASSPHRASE!,
} as any, 2, process.env.POLYMARKET_ADDRESS);  // use proxy as funder

// Try a real order on a liquid market (Trump/Kamala 2024 - resolved)
// Use a tiny live market for test
try {
  const orderArgs = {
    tokenID: '21742633143463906290569050155826241533067272736897614950488156847949938836455', // YES Trump wins 2024
    price: 0.99,
    side: 'BUY' as any,
    size: 1,
  };
  const signed = await c.createOrder(orderArgs);
  console.log('Order signed OK:', JSON.stringify(signed).slice(0,100));
  
  // Actually place it
  const resp = await c.postOrder(signed, 'GTC' as any);
  console.log('Order response:', JSON.stringify(resp).slice(0,200));
} catch(e: any) {
  console.log('Error:', e.message?.slice(0,100));
}
