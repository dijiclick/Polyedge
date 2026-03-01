import { Wallet } from '@ethersproject/wallet';
const pk = process.env.POLYMARKET_PRIVATE_KEY!;
const w = new Wallet(pk);
console.log('POLYMARKET_PRIVATE_KEY derives:', w.address);
console.log('POLYMARKET_ADDRESS:            ', process.env.POLYMARKET_ADDRESS);
console.log('Match:', w.address.toLowerCase() === process.env.POLYMARKET_ADDRESS?.toLowerCase());
