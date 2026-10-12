/**
 * Minimal HTML escaping for Telegram `parse_mode: 'HTML'` messages.
 *
 * Telegram rejects raw `<`, `>`, and `&` in message text (it parses them as
 * entities), and a Roblox game name or username can legitimately contain any of
 * them — so every dynamic value interpolated into an HTML message must go
 * through this first. Only these three characters need escaping for Telegram's
 * HTML subset.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[<>&]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&amp;';
    }
  });
}
