import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const execute = promisify(execFile)

async function verifyExtracted(root) {
  const runtime = path.join(root, 'runtime', 'node.exe')
  const launcher = path.join(root, 'launcher.mjs')
  const app = path.join(root, 'app')
  const data = path.join(root, 'acceptance-data')
  assert.ok(existsSync(runtime), 'Extracted package is missing runtime/node.exe')
  assert.ok(existsSync(launcher), 'Extracted package is missing launcher.mjs')

  const appRequire = createRequire(path.join(app, 'package.json'))
  const readableStream = appRequire('readable-stream')
  assert.equal(typeof readableStream.Readable, 'function')
  for (const [name, specifier, version] of [['process', 'process/', '0.11.10'], ['string_decoder', 'string_decoder/', '1.3.0'], ['safe-buffer', 'safe-buffer', '5.2.1']]) {
    const resolved = appRequire.resolve(specifier)
    let directory = path.dirname(resolved), actualVersion
    while (directory !== path.dirname(directory)) {
      const packageFile = path.join(directory, 'package.json')
      if (existsSync(packageFile)) {
        const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'))
        if (pkg.name === name) { actualVersion = pkg.version; break }
      }
      directory = path.dirname(directory)
    }
    assert.equal(actualVersion, version, `Portable package has the wrong ${name} package`)
  }

  const env = { ...process.env, PORT: '0', VEHICLE_MANAGER_AUTO_STOP: '0', VEHICLE_MANAGER_DATA_DIR: data, PATH: path.dirname(runtime), NODE_OPTIONS: '' }
  delete env.NODE_PATH
  delete env.npm_execpath
  let started = false
  let stopped = false
  try {
    await execute(runtime, [launcher, '--no-browser'], { cwd: root, env, timeout: 30000 })
    started = true
    const state = JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8'))
    const origin = `http://127.0.0.1:${state.port}`
    const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { 'X-App-Request': 'vehicle-manager' }, signal: AbortSignal.timeout(10000) })
    assert.equal(bootstrap.status, 200, 'The packaged service /api/bootstrap request failed')
    const result = await bootstrap.json()
    assert.equal(result.version, JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8')).version)
    const loginPage = await fetch(origin, { signal: AbortSignal.timeout(10000) })
    assert.equal(loginPage.status, 200, 'The packaged login page request failed')
    const html = await loginPage.text()
    assert.match(html, /<div id="root"><\/div>/, 'The packaged login page root is missing')
    const asset = html.match(/src="([^"]+\.js)"/)
    assert.ok(asset, 'The packaged login page JavaScript asset is missing')
    const javascript = await fetch(new URL(asset[1], origin), { signal: AbortSignal.timeout(10000) })
    assert.equal(javascript.status, 200, 'The packaged login page JavaScript failed to load')
    await execute(runtime, [launcher, '--stop'], { cwd: root, env, timeout: 15000 })
    for (let attempt = 0; attempt < 200 && existsSync(path.join(data, 'service.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(existsSync(path.join(data, 'service.json')), false, 'The packaged service did not stop cleanly')
    stopped = true
    console.log(JSON.stringify({ bundledRuntime: true, readableStream: true, process: '0.11.10', string_decoder: '1.3.0', safe_buffer: '5.2.1', bootstrap: bootstrap.status, loginPage: loginPage.status, javascript: javascript.status, gracefulStop: stopped }))
  } finally {
    if (started && !stopped) await execute(runtime, [launcher, '--stop'], { cwd: root, env, timeout: 15000 }).catch(() => {})
  }
}

async function extractAndVerify(zip) {
  assert.equal(process.platform, 'win32', 'Portable package acceptance must run on Windows.')
  assert.equal(process.arch, 'x64', 'Portable package acceptance must run on Windows x64.')
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-manager-acceptance-'))
  try {
    const escape = value => value.replaceAll("'", "''")
    const command = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${escape(zip)}' -DestinationPath '${escape(destination)}'`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: 'inherit' })
    const entries = await fs.readdir(destination, { withFileTypes: true })
    const folders = entries.filter(entry => entry.isDirectory())
    assert.equal(folders.length, 1, 'ZIP must contain exactly one package folder')
    const extracted = path.join(destination, folders[0].name)
    const env = { ...process.env, PATH: path.join(extracted, 'runtime'), NODE_OPTIONS: '', PORT: '0', VEHICLE_MANAGER_AUTO_STOP: '0', VEHICLE_MANAGER_DATA_DIR: path.join(extracted, 'acceptance-data') }
    delete env.NODE_PATH
    delete env.npm_execpath
    execFileSync(path.join(extracted, 'runtime', 'node.exe'), [path.join(extracted, 'verify-portable.mjs'), '--verify-extracted', extracted], { cwd: extracted, env, stdio: 'inherit', timeout: 120000 })
  } finally {
    await fs.rm(destination, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--verify-extracted') await verifyExtracted(path.resolve(process.argv[3]))
else {
  const zip = path.resolve(process.argv[2] || '')
  assert.ok(existsSync(zip), 'Pass the final portable ZIP to verify.')
  await extractAndVerify(zip)
}