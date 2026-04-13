const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

export async function sendAlert(level, service, message, details = {}) {
  if (!DISCORD_WEBHOOK_URL) return;

  const colors = { critical: 0xFF0000, warning: 0xFFA500, info: 0x00FF00 };

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `${level === 'critical' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️'} ${service} — ${level.toUpperCase()}`,
          description: message,
          color: colors[level] || 0x808080,
          fields: Object.entries(details).map(([k, v]) => ({ name: k, value: String(v), inline: true })),
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* fire and forget */ }
}
