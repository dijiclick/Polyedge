import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

const provider = new JsonRpcProvider({url:'https://rpc.ankr.com/polygon',timeout:15000}, 137);
const wallet   = new Wallet(process.env.PRIVATE_KEY!, provider);

// Try signature type 0 (EOA signs as maker directly)
const c = new ClobClient('https://clob.polymarket.com', 137, wallet, {
  key: process.env.CLOB_API_KEY!, secret: process.env.CLOB_SECRET!, passphrase: process.env.CLOB_PASSPHRASE!,
} as any);  // no funder = sig type 0

const tokenId = '24585844458736164795732411521055224715797544586245891440771485656403248933682';
const order = await c.createOrder({ tokenID: tokenId, price: 0.53, side: 'BUY' as any, size: 1 });
console.log('Maker:', order.maker, '| sigType:', order.signatureType);
const resp = await c.postOrder(order, 'GTC' as any);
console.log('Response:', JSON.stringify(resp).slice(0,200));
