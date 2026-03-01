import { getUsdcBalance } from './src/shared/clob.ts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';

const provider = new JsonRpcProvider('https://rpc.ankr.com/polygon', 137);
const abi = ['function balanceOf(address) view returns (uint256)'];

for (const addr of [process.env.FUNDER_ADDRESS!, process.env.POLYMARKET_ADDRESS!]) {
  for (const [tok, name] of [
    ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174','USDC.e'],
    ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359','USDC']
  ]) {
    const c = new Contract(tok as string, abi, provider);
    const b = await c.balanceOf(addr);
    console.log(`${addr.slice(0,12)} ${name}: $${(Number(b)/1e6).toFixed(4)}`);
  }
}
const clob = await getUsdcBalance();
console.log('CLOB exchange balance: $' + clob.toFixed(4));
