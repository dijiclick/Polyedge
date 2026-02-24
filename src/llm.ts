/**
 * LLM client — OpenRouter
 * Models: DeepSeek V3.2 (default), DeepSeek:online (web search)
 */

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || '';

const DEFAULT_MODEL = 'deepseek/deepseek-chat';
const SEARCH_MODEL  = 'deepseek/deepseek-chat:online';

export interface SearchResult {
  answer:    string;
  citations: { url: string; title: string; content?: string }[];
}

export async function ask(prompt: string, opts: { model?: string; temperature?: number } = {}): Promise<string> {
  const { model = DEFAULT_MODEL, temperature = 0.1 } = opts;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages:    [{ role: 'user', content: prompt }],
      temperature,
      max_tokens:  1024,
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const d: any = await res.json();
  return d.choices?.[0]?.message?.content ?? '';
}

export async function search(query: string): Promise<SearchResult> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:    SEARCH_MODEL,
      messages: [{ role: 'user', content: query }],
      plugins:  [{ id: 'web', max_results: 5 }],
    }),
  });
  if (!res.ok) throw new Error(`Search error ${res.status}: ${await res.text()}`);
  const d: any = await res.json();
  const msg = d.choices?.[0]?.message;
  return {
    answer:    msg?.content ?? '',
    citations: (msg?.annotations ?? [])
      .filter((a: any) => a.type === 'url_citation')
      .map((a: any) => ({ url: a.url_citation?.url ?? '', title: a.url_citation?.title ?? '', content: a.url_citation?.content ?? '' })),
  };
}
