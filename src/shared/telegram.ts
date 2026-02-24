const TOKEN = process.env.TELEGRAM_TOKEN || '8368586173:AAGcL1dNnR06Go5AsrIy26Ud9NtOcUPS4GbU';
const CHAT  = process.env.TELEGRAM_CHAT  || '63129119';

export async function tg(text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' }),
    });
  } catch {}
}
