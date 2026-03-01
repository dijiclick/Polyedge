/**
 * Telegram notification stub.
 * Logs to console. Replace with real bot token to get live alerts.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

export async function tg(message: string): Promise<void> {
  const text = message.replace(/<[^>]+>/g, ''); // strip HTML tags for console
  console.log(`[tg] ${text.slice(0, 120)}`);

  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) {
    // non-fatal — never crash the bot over a notification
  }
}
