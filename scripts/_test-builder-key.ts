#!/usr/bin/env npx tsx
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getClient } from '../src/shared/clob.js';

function loadEnv(p: string) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#') || !l.includes('=')) continue;
      const [k, ...rest] = l.split('=');
      if (!process.env[k.trim()]) process.env[k.trim()] = rest.join('=').trim();
    }
  } catch {}
}
loadEnv(resolve(process.cwd(), '.env'));
loadEnv('/home/ariad/.openclaw/workspace/Polyedge/.env');

async function main() {
  const client = await getClient();

  // Check existing builder keys
  try {
    const keys = await client.getBuilderApiKeys();
    console.log('Existing builder keys:', JSON.stringify(keys, null, 2));
  } catch (e: any) {
    console.log('getBuilderApiKeys error:', e.message?.slice(0, 300));
  }

  // Create a new builder key
  try {
    const newKey = await client.createBuilderApiKey();
    console.log('Created builder key:', JSON.stringify(newKey, null, 2));
  } catch (e: any) {
    console.log('createBuilderApiKey error:', e.message?.slice(0, 300));
  }
}

main().catch(e => console.error('Fatal:', e.message));
