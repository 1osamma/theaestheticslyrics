import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Live checks against lrclib.net and this PC's audio; kept out of the default `npm test` run.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests-live/**/*.live.test.ts'],
    environment: 'node',
    fileParallelism: false
  }
})
