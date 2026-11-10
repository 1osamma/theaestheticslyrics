/** Song time as the player shows it: m:ss, or h:mm:ss past an hour. Negative or unknown is 0:00. */
export function formatTime(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Playback progress 0–1; 0 when the player reports no duration. */
export function progressOf(songMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 0
  return Math.min(1, Math.max(0, songMs / durationMs))
}

/** The player app's name for the top bar, or '' for apps without a friendly name. */
export function sourceLabel(app: string): string {
  if (/spotify/i.test(app)) return 'Spotify'
  if (/AppleInc\.AppleMusic|itunes/i.test(app)) return 'Apple Music'
  return ''
}

/** A trailing "(feat. …)", "[with …]" or " - Remastered 2011" style suffix. */
const TITLE_EXTRA = /\s*(?:[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s-\s.*\b(?:remaster(?:ed)?|live|version|edit|mix|mono|stereo)\b.*)$/i

/**
 * Splits a track title into the name and a secondary suffix the player shows quieter, so
 * "Song (feat. Someone)" does not wrap onto two heavy lines.
 */
export function splitTitle(title: string): { main: string; extra: string } {
  const trimmed = title.trim()
  const match = TITLE_EXTRA.exec(trimmed)
  if (!match || match.index === 0) return { main: trimmed, extra: '' }
  return { main: trimmed.slice(0, match.index).trim(), extra: match[0].trim() }
}
