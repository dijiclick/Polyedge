import { Wallet } from '@ethersproject/wallet';
const wallet = new Wallet(process.env.PRIVATE_KEY!);
console.log('PRIVATE_KEY derives address:', wallet.address);
console.log('FUNDER_ADDRESS in .env:     ', process.env.FUNDER_ADDRESS);
console.log('POLYMARKET_ADDRESS in .env: ', process.env.POLYMARKET_ADDRESS);
console.log('EOA match:', wallet.address.toLowerCase() === process.env.FUNDER_ADDRESS?.toLowerCase());
