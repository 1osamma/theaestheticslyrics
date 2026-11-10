// Builds resources/lumina-helper.exe (WASAPI audio capture + full-screen detection) from
// native/lumina-helper/*.cs with the C# compiler that ships with .NET Framework 4.x on every
// Windows 10/11 PC: no SDK, no downloads, and the result needs no runtime install. Skips the build
// when the exe is newer than every source file.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'native', 'lumina-helper')
const out = join(root, 'resources', 'lumina-helper.exe')
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.cs'))
  .map((f) => join(srcDir, f))

if (process.platform !== 'win32') {
  console.log('lumina-helper: skipped (Windows only)')
  process.exit(0)
}

const newest = Math.max(...sources.map((f) => statSync(f).mtimeMs), statSync(fileURLToPath(import.meta.url)).mtimeMs)
if (existsSync(out) && statSync(out).mtimeMs >= newest && !process.argv.includes('--force')) {
  console.log('lumina-helper: up to date')
  process.exit(0)
}

const windir = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) {
  console.error(`lumina-helper: C# compiler not found at ${csc} (.NET Framework 4.x is part of Windows 10/11)`)
  process.exit(1)
}

const result = spawnSync(
  csc,
  ['/nologo', '/optimize+', '/unsafe', '/platform:x64', '/target:exe', `/out:${out}`, ...sources],
  { stdio: 'inherit' }
)
if (result.status !== 0) {
  console.error('lumina-helper: build failed')
  process.exit(result.status ?? 1)
}
console.log(`lumina-helper: built ${out}`)
