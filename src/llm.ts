/**
 * LLM client
 * - ask()    → DeepSeek V3 via OpenRouter (reasoning)
 * - search() → Perplexity sonar-pro via local proxy (http://localhost:8320/v1)
 *              Falls back to Pro API → session-token bridge
 */

import { spawnSync } from 'child_process';

const OPENROUTER_API_KEY   = process.env.OPENROUTER_API_KEY   || '';
const PERPLEXITY_API_KEY   = process.env.PERPLEXITY_API_KEY   || '';

// Session token pool — all 11 accounts
const SESSION_TOKENS: string[] = [
  process.env.PERPLEXITY_SESSION_TOKEN    || '',
  process.env.PERPLEXITY_SESSION_TOKEN_1  || '',
  process.env.PERPLEXITY_SESSION_TOKEN_6  || '',
  process.env.PERPLEXITY_SESSION_TOKEN_7  || '',
  process.env.PERPLEXITY_SESSION_TOKEN_8  || '',
  process.env.PERPLEXITY_SESSION_TOKEN_9  || '',
  process.env.PERPLEXITY_SESSION_TOKEN_10 || '',
  process.env.PERPLEXITY_SESSION_TOKEN_11 || '',
  process.env.PERPLEXITY_SESSION_TOKEN_12 || '',
  process.env.PERPLEXITY_SESSION_TOKEN_13 || '',
  process.env.PERPLEXITY_SESSION_TOKEN_14 || '',
].filter(Boolean);

let _sessionIdx = 0;
function nextSessionToken(): string {
  const t = SESSION_TOKENS[_sessionIdx % SESSION_TOKENS.length];
  _sessionIdx++;
  return t;
}

const DEFAULT_MODEL = 'deepseek/deepseek-chat';
const BRIDGE_PATH   = process.env.PERPLEXITY_BRIDGE_PATH
  || '/home/ariad/.openclaw/workspace/polyedge/perplexity_bridge.py';
const UV_CMD        = process.env.UV_CMD || '/home/ariad/.local/bin/uv';

export interface SearchResult {
  answer:    string;
  citations: { url: string; title: string; content?: string }[];
}

// ─── Reasoning via DeepSeek ────────────────────────────────────────────────
export async function ask(
  prompt: string,
  opts: { model?: string; temperature?: number } = {}
): Promise<string> {
  const { model = DEFAULT_MODEL, temperature = 0.1 } = opts;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      messages:   [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const d: any = await res.json();
  return d.choices?.[0]?.message?.content ?? '';
}

// ─── Search via Perplexity sonar-pro API ──────────────────────────────────
async function searchViaAPI(query: string): Promise<SearchResult> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'sonar',
      messages: [{ role: 'user', content: query }],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${txt}`);
  }
  const d: any = await res.json();
  const msg     = d.choices?.[0]?.message;
  const content = msg?.content ?? '';

  // Extract citations from response
  const citations = (d.citations ?? []).map((url: string, i: number) => ({
    url,
    title:   `Source ${i + 1}`,
    content: '',
  }));

  return { answer: content, citations };
}

// ─── Search via session-token bridge (fallback) ────────────────────────────
function searchViaBridge(query: string): SearchResult {
  const token = nextSessionToken();
  if (!token) throw new Error('No session tokens available');

  const input = JSON.stringify({ question: query, description: '', end_date: '' });
  const result = spawnSync(
    UV_CMD,
    ['run', '--script', BRIDGE_PATH],
    {
      input,
      encoding: 'utf8',
      timeout:  90_000,
      env: { ...process.env, PERPLEXITY_SESSION_TOKEN: token },
    }
  );

  if (result.error) throw new Error(`Bridge spawn error: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Bridge exit ${result.status}: ${result.stderr?.slice(0, 200)}`);

  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      answer:    parsed.reasoning ?? parsed.answer ?? '',
      citations: [],
    };
  } catch {
    throw new Error(`Bridge parse error: ${result.stdout.slice(0, 200)}`);
  }
}

// ─── Public search() — Pro API first, bridge fallback ─────────────────────
// ─── Search via local proxy (Scrapling-based, no API key needed) ──────────
const PERPLEXITY_PROXY = process.env.PERPLEXITY_PROXY_URL || 'http://localhost:8320';

async function searchViaProxy(query: string): Promise<SearchResult> {
  const res = await fetch(`${PERPLEXITY_PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer local', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Proxy error ${res.status}`);
  const d: any = await res.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  const content = d.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Empty proxy response');
  return { answer: content, citations: [] };
}

export async function search(query: string): Promise<SearchResult> {
  // 1. Try local proxy first (Scrapling-based, uses session tokens, no API key)
  try {
    const result = await searchViaProxy(query);
    console.log('[llm] ✅ Perplexity proxy hit');
    return result;
  } catch (e: any) {
    console.warn(`[llm] Proxy failed (${e.message?.slice(0, 80)}), trying API...`);
  }

  // 2. Fallback: Pro API key
  if (PERPLEXITY_API_KEY) {
    try {
      return await searchViaAPI(query);
    } catch (e: any) {
      console.warn(`[llm] Perplexity API failed (${e.message?.slice(0, 80)}), trying bridge pool...`);
    }
  }

  // 3. Last resort: session-token bridge pool
  const errors: string[] = [];
  for (let i = 0; i < SESSION_TOKENS.length; i++) {
    try {
      return searchViaBridge(query);
    } catch (e: any) {
      errors.push(e.message?.slice(0, 60));
    }
  }

  throw new Error(`All Perplexity sources failed: ${errors.join(' | ')}`);
}
