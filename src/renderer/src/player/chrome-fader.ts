/** Chrome (cursor, top bar) hides this long after the last mouse move. */
export const CHROME_HIDE_MS = 2600

/**
 * Shows the player's chrome on interaction and fades it when the mouse rests. Only watch-only
 * sessions show it: on a screen that closes on any input, a mouse move closes the screen instead.
 */
export class ChromeFader {
  private lastPoke = Number.NEGATIVE_INFINITY

  constructor(private readonly hideAfterMs = CHROME_HIDE_MS) {}

  poke(now: number): void {
    this.lastPoke = now
  }

  hide(): void {
    this.lastPoke = Number.NEGATIVE_INFINITY
  }

  visible(now: number): boolean {
    return now - this.lastPoke < this.hideAfterMs
  }
}
