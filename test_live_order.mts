import { getClient } from './src/shared/clob.ts';

const c = await getClient();

// Get a live market token — Atalanta NO token
const tokenId = '24585844458736164795732411521055224715797544586245891440771485656403248933682';

try {
  const order = await c.createOrder({
    tokenID: tokenId,
    price: 0.53,  // NO @ 53¢
    side: 'BUY' as any,
    size: 1,      // $0.53 worth
  });
  console.log('Order created:', order.maker, order.side, order.makerAmount);
  
  const resp = await c.postOrder(order, 'GTC' as any);
  console.log('Response:', JSON.stringify(resp).slice(0, 200));
} catch(e: any) {
  console.log('Error:', e.message?.slice(0,100));
}
