import { promises as fs, createWriteStream, existsSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ZipArchive } from 'archiver'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this portable package on Windows x64.')
const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const name = `vehicle-manager-${manifest.version}-win-x64-${stamp}`
const release = path.join(project, 'releases', name), application = path.join(release, 'app')
if (!existsSync(path.join(project, 'dist', 'index.html')) || !existsSync(path.join(project, 'dist-server', 'server', 'main.js'))) throw new Error('Run npm run build first.')
await fs.mkdir(application, { recursive: true })
for (const folder of ['dist', 'dist-server']) await fs.cp(path.join(project, folder), path.join(application, folder), { recursive: true })
for (const file of ['Start.cmd', 'Stop.cmd', 'launcher.mjs']) await fs.copyFile(path.join(project, file), path.join(release, file))
await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies, overrides: manifest.overrides }, null, 2))
await fs.copyFile(path.join(project, '使用说明.md'), path.join(release, '使用说明.md'))
await fs.mkdir(path.join(release, 'runtime'))
await fs.copyFile(process.execPath, path.join(release, 'runtime', 'node.exe'))
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE')
if (!existsSync(nodeLicense)) throw new Error('The Node.js LICENSE must be present next to the build runtime.')
await fs.copyFile(nodeLicense, path.join(release, 'runtime', 'LICENSE'))
const visited = new Set(), notices = []
async function include(name, from, optional = false) {
  if (isBuiltin(name)) return
  const search = createRequire(path.join(from, 'package.json')).resolve.paths(name) || []
  const directory = search.map(base => path.join(base, name)).find(candidate => existsSync(path.join(candidate, 'package.json')))
  if (!directory) { if (optional) return; throw new Error(`Missing runtime dependency: ${name}`) }
  if (visited.has(directory)) return
  visited.add(directory)
  const relative = path.relative(path.join(project, 'node_modules'), directory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Dependency is outside this project's node_modules: ${name}`)
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  await fs.cp(directory, path.join(application, 'node_modules', relative), { recursive: true })
  notices.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'See included package license' })
  for (const dependency of Object.keys(pkg.dependencies || {})) await include(dependency, directory)
  for (const dependency of Object.keys(pkg.optionalDependencies || {})) await include(dependency, directory, true)
  for (const dependency of Object.keys(pkg.peerDependencies || {})) await include(dependency, directory, true)
}
for (const dependency of Object.keys(manifest.dependencies)) await include(dependency, project)
await fs.writeFile(path.join(release, 'THIRD-PARTY-NOTICES.json'), JSON.stringify({ node: process.versions.node, packages: notices.sort((left, right) => left.name.localeCompare(right.name)), note: 'Package licenses are included in their respective directories.' }, null, 2))
await fs.writeFile(path.join(release, 'README.txt'), `STELLANTIS Vehicle Data Management ${manifest.version}\r\n\r\n1. Extract this entire folder to a writable local folder. Do not run it inside the ZIP or from the team share.\r\n2. Double-click Start.cmd. The local service opens your browser; a different free local port is used if necessary.\r\n3. Create your own local account. Enter the existing Windows SMB folder in Shared folder settings.\r\n4. Only the team owner creates a team in an empty folder; colleagues select the same existing team and request approval.\r\n5. Close the browser without stopping the service, or use Stop.cmd to finish pending work and stop safely.\r\n6. Local data is generated in data/. Do not copy someone else's data/ or distribute it to colleagues. Back up before upgrading.\r\n7. This package contains no accounts, vehicles, reports or preconfigured share. Company application control still applies.\r\n8. Backups are not encrypted. Keep them in approved protected storage. Real SMB multi-computer acceptance is required before sensitive use.\r\n`)
const zipFile = path.join(project, 'releases', `${name}.zip`), output = createWriteStream(zipFile), archive = new ZipArchive({ zlib: { level: 6 } })
const completed = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); archive.once('error', reject) })
archive.pipe(output); archive.directory(release, name); await archive.finalize(); await completed
console.log(JSON.stringify({ folder: release, zip: zipFile, packages: visited.size, bytes: (await fs.stat(zipFile)).size }))