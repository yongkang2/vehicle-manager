import { promises as fs, createWriteStream, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this portable package on Windows x64.')
const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const name = `vehicle-manager-${manifest.version}-win-x64-${stamp}`
const release = path.join(project, 'releases', name), application = path.join(release, 'app')
if (!existsSync(path.join(project, 'dist', 'index.html')) || !existsSync(path.join(project, 'dist-server', 'server', 'main.js'))) throw new Error('Run npm run build first.')
const production = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-manager-production-'))
try {
  await fs.copyFile(path.join(project, 'package.json'), path.join(production, 'package.json'))
  await fs.copyFile(path.join(project, 'package-lock.json'), path.join(production, 'package-lock.json'))
  const npmCli = process.env.npm_execpath
  if (!npmCli || !existsSync(npmCli)) throw new Error('Run packaging through npm run package:portable so npm ci can use the project lockfile.')
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: production, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`Production dependency installation failed with exit code ${install.status}.`)

  await fs.mkdir(application, { recursive: true })
  for (const folder of ['dist', 'dist-server']) await fs.cp(path.join(project, folder), path.join(application, folder), { recursive: true })
  await fs.cp(path.join(production, 'node_modules'), path.join(application, 'node_modules'), { recursive: true })
  for (const file of ['Start.cmd', 'Stop.cmd', 'launcher.mjs']) await fs.copyFile(path.join(project, file), path.join(release, file))
  await fs.copyFile(path.join(project, 'scripts', 'verify-portable.mjs'), path.join(release, 'verify-portable.mjs'))
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies, overrides: manifest.overrides }, null, 2))
  await fs.copyFile(path.join(project, '使用说明.md'), path.join(release, '使用说明.md'))
  await fs.mkdir(path.join(release, 'runtime'))
  await fs.copyFile(process.execPath, path.join(release, 'runtime', 'node.exe'))
  const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE')
  if (!existsSync(nodeLicense)) throw new Error('The Node.js LICENSE must be present next to the build runtime.')
  await fs.copyFile(nodeLicense, path.join(release, 'runtime', 'LICENSE'))

  const notices = []
  async function collectPackages(nodeModules) {
    for (const entry of await fs.readdir(nodeModules, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      const entryPath = path.join(nodeModules, entry.name)
      if (entry.name.startsWith('@')) {
        for (const scoped of await fs.readdir(entryPath, { withFileTypes: true })) if (scoped.isDirectory()) await collectPackage(path.join(entryPath, scoped.name))
      } else if (entry.isDirectory()) await collectPackage(entryPath)
    }
  }
  async function collectPackage(directory) {
    const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    notices.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'See included package license' })
    const nested = path.join(directory, 'node_modules')
    if (existsSync(nested)) await collectPackages(nested)
  }
  await collectPackages(path.join(application, 'node_modules'))
  await fs.writeFile(path.join(release, 'THIRD-PARTY-NOTICES.json'), JSON.stringify({ node: process.versions.node, packages: notices.sort((left, right) => left.name.localeCompare(right.name)), note: 'Package licenses are included in their respective directories.' }, null, 2))
  await fs.writeFile(path.join(release, 'README.txt'), `STELLANTIS Vehicle Data Management ${manifest.version}\r\n\r\n1. Extract this entire folder to a writable local folder. Do not run it inside the ZIP or from the team share.\r\n2. Double-click Start.cmd. The local service opens your browser; a different free local port is used if necessary.\r\n3. Create your own local account. Enter the existing Windows SMB folder in Shared folder settings.\r\n4. Only the team owner creates a team in an empty folder; colleagues select the same existing team and request approval.\r\n5. Closing the last application tab enables auto-stop after a reconnect grace period. Active sync finishes; offline changes stay queued. Use Stop.cmd before upgrading. See the included guide for timing and VEHICLE_MANAGER_AUTO_STOP settings.\r\n6. Local data is generated in data/. Do not copy someone else's data/ or distribute it to colleagues. Back up before upgrading.\r\n7. This package contains no accounts, vehicles, reports or preconfigured share. Company application control still applies.\r\n8. Backups are not encrypted. Keep them in approved protected storage. Real SMB multi-computer acceptance is required before sensitive use.\r\n`)
  const zipFile = path.join(project, 'releases', `${name}.zip`), output = createWriteStream(zipFile), archive = new ZipArchive({ zlib: { level: 6 } })
  const completed = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); archive.once('error', reject) })
  archive.pipe(output); archive.directory(release, name); await archive.finalize(); await completed

  const verification = spawnSync(process.execPath, [path.join(project, 'scripts', 'verify-portable.mjs'), zipFile], { stdio: 'inherit' })
  if (verification.error || verification.status !== 0) {
    await fs.rm(zipFile, { force: true })
    await fs.rm(release, { recursive: true, force: true })
    if (verification.error) throw verification.error
    throw new Error(`Portable package acceptance failed with exit code ${verification.status}.`)
  }
  console.log(JSON.stringify({ folder: release, zip: zipFile, packages: notices.length, bytes: (await fs.stat(zipFile)).size, acceptance: 'passed' }))
} finally {
  await fs.rm(production, { recursive: true, force: true })
}