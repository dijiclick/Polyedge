import { search, ask } from './src/llm.js';

console.log('=== Test 1: Perplexity Pro API (sonar-pro) ===');
try {
  const t0 = Date.now();
  const r = await search('Did the Lakers play last night? What was the result?');
  console.log(`✅ SUCCESS in ${Date.now()-t0}ms`);
  console.log('Answer:', r.answer.slice(0, 300));
  console.log('Citations:', r.citations.length);
} catch(e: any) {
  console.log('❌ FAILED:', e.message);
}

console.log('\n=== Test 2: DeepSeek via OpenRouter ===');
try {
  const t0 = Date.now();
  const r = await ask('Reply with exactly: DeepSeek OK');
  console.log(`✅ SUCCESS in ${Date.now()-t0}ms:`, r.trim());
} catch(e: any) {
  console.log('❌ FAILED:', e.message);
}

console.log('\n=== Test 3: uv bridge fallback ===');
try {
  const t0 = Date.now();
  // Temporarily disable API key to force bridge fallback
  const r = await search('Who won Super Bowl 2025?');
  console.log(`✅ bridge in ${Date.now()-t0}ms:`, r.answer.slice(0,200));
} catch(e: any) {
  console.log('❌ bridge FAILED:', e.message);
}
