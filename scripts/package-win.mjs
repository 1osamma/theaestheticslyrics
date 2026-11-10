// Packages the built app (out/) into a portable folder: release/theaestheticslyrics-win32-x64/theaestheticslyrics.exe
// No installer: copy the folder anywhere and run theaestheticslyrics.exe.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const AUTHOR = 'darshanseenivasakumar'

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('out/ is missing: run "npm run build" first')
  process.exit(1)
}

const [appDir] = await packager({
  dir: root,
  out: join(root, 'release'),
  name: 'theaestheticslyrics',
  executableName: 'theaestheticslyrics',
  appVersion: pkg.version,
  platform: 'win32',
  arch: 'x64',
  asar: true,
  prune: true,
  overwrite: true,
  icon: join(root, 'resources', 'icon.ico'),
  // PowerShell cannot read files inside an asar archive, and executables cannot run from one, so the
  // bridge and the audio helper ship beside it.
  extraResource: ['smtc-bridge.ps1', 'lumina-helper.exe', 'tray.ico', 'icon.ico'].map((f) => join(root, 'resources', f)),
  ignore: [
    // Every library is bundled into out/ by electron-vite, so nothing from node_modules ships.
    /^\/node_modules(\/|$)/,
    /^\/(src|tests|tests-live|scripts|docs|snapshots|release|resources|\.remember|\.git|\.github|\.claude)(\/|$)/,
    /^\/(electron\.vite|vitest|vitest\.live)\.config\.ts$/,
    /^\/tsconfig[^/]*\.json$/,
    /^\/(\.gitignore|\.gitattributes|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/
  ],
  appCopyright: `Copyright © 2026 ${AUTHOR}`,
  win32metadata: {
    CompanyName: 'theaestheticslyrics',
    FileDescription: 'theaestheticslyrics',
    ProductName: 'theaestheticslyrics',
    InternalName: 'theaestheticslyrics',
    OriginalFilename: 'theaestheticslyrics.exe'
  }
})
console.log(`packaged: ${appDir}`)

// The folder root already holds Electron's own LICENSE, so ours ship under distinct names.
copyFileSync(join(root, 'LICENSE'), join(appDir, 'LICENSE.theaestheticslyrics.txt'))
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(appDir, 'THIRD_PARTY_NOTICES.txt'))

// A zip of the folder is handy for moving it to another PC.
const zip = join(root, 'release', `theaestheticslyrics-${pkg.version}-win-x64.zip`)
rmSync(zip, { force: true })
const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -Force`],
  { stdio: 'inherit' }
)
if (result.status === 0) console.log(`zipped: ${zip}`)
else console.warn('zip step failed (the folder above is still complete)')
