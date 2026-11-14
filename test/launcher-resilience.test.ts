import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'

const execute = promisify(execFile)
async function fixture(script: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm 启动 resilience-'))
  const data = path.join(root, 'local data')
  await fs.mkdir(path.join(root, 'dist-server/server'), { recursive: true })
  await fs.mkdir(path.join(root, 'dist-server/shared'), { recursive: true })
  await fs.mkdir(data)
  await fs.copyFile(path.resolve('launcher.mjs'), path.join(root, 'launcher.mjs'))
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.7.0","type":"module"}')
  await fs.writeFile(path.join(root, 'dist-server/shared/data-directory.js'), 'export const resolveDataDirectory = () => { throw new Error("override expected") }')
  await fs.writeFile(path.join(root, 'dist-server/server/timestamp-output.js'), '')
  await fs.writeFile(path.join(root, 'dist-server/server/main.js'), `import fs from 'node:fs';import path from 'node:path';fs.appendFileSync(path.join(process.env.VEHICLE_MANAGER_DATA_DIR,'attempts'),'1');${script}`)
  return {
    root, data,
    run: (port = '0') => execute(process.execPath, [path.join(root, 'launcher.mjs'), '--no-browser'], { env: { ...process.env, PORT: port, VEHICLE_MANAGER_DATA_DIR: data }, windowsHide: true, timeout: 15000 }),
    clean: () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}
const ready = `import {createHash} from 'node:crypto';process.send({type:'ready',port:12345,instanceId:createHash('sha256').update(path.resolve(process.env.VEHICLE_MANAGER_DATA_DIR).toLowerCase()).digest('hex')});setTimeout(()=>process.exit(),200);`

test('an old empty startup lock recovers without user intervention', async () => {
  const f = await fixture(ready)
  try {
    const lock = path.join(f.data, '.launch-lock')
    await fs.mkdir(lock)
    await fs.utimes(lock, new Date(0), new Date(0))
    assert.match((await f.run()).stdout, /Vehicle Data Management/)
  } finally { await f.clean() }
})

test('a second launcher waits for the current startup lock to be released', async () => {
  const f = await fixture(ready)
  try {
    const lock = path.join(f.data, '.launch-lock')
    await fs.mkdir(lock)
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token: 'other-launcher', pid: process.pid }))
    const release = setTimeout(() => { void fs.rm(lock, { recursive: true }) }, 500)
    try { assert.match((await f.run()).stdout, /Vehicle Data Management/) }
    finally { clearTimeout(release) }
  } finally { await f.clean() }
})

test('a startup lock left by an exited process is recovered', async () => {
  const f = await fixture(ready)
  try {
    const result = await execute(process.execPath, ['-e', 'console.log(process.pid)'], { windowsHide: true })
    const lock = path.join(f.data, '.launch-lock')
    await fs.mkdir(lock)
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: Number(result.stdout.trim()), token: 'crashed' }))
    assert.match((await f.run()).stdout, /Vehicle Data Management/)
  } finally { await f.clean() }
})

test('invalid ports fail before spawning and an unwritable launcher log is reported', async () => {
  const f = await fixture(ready)
  try {
    await fs.mkdir(path.join(f.root, 'launcher.log'))
    await assert.rejects(f.run('65536'), error => {
      const stderr = (error as { stderr: string }).stderr
      assert.match(stderr, /PORT must be an integer/)
      assert.match(stderr, /Could not write launcher log/)
      return true
    })
    assert.equal(await fs.access(path.join(f.data, 'attempts')).then(() => true, () => false), false)
  } finally { await f.clean() }
})

test('a fatal startup exit is attempted once and reports its exit code and actual log path', async () => {
  const f = await fixture('process.exit(7)')
  try {
    await assert.rejects(f.run('4410'), error => {
      const stderr = (error as { stderr: string }).stderr
      assert.match(stderr, /code 7/)
      assert(stderr.includes(path.join(f.data, 'startup.log')))
      return true
    })
    assert.equal(await fs.readFile(path.join(f.data, 'attempts'), 'utf8'), '1')
  } finally { await f.clean() }
})

test('only an explicit port conflict retries on the next port', async () => {
  const f = await fixture(`import {createHash} from 'node:crypto';if(!fs.existsSync(path.join(process.env.VEHICLE_MANAGER_DATA_DIR,'retried'))){fs.writeFileSync(path.join(process.env.VEHICLE_MANAGER_DATA_DIR,'retried'),'1');process.send({type:'error',code:'EADDRINUSE'});setTimeout(()=>process.exit(1),200);}else{${ready.replace("import {createHash} from 'node:crypto';", '')}}`)
  try {
    assert.match((await f.run('4410')).stdout, /Vehicle Data Management/)
    assert.equal(await fs.readFile(path.join(f.data, 'attempts'), 'utf8'), '11')
  } finally { await f.clean() }
})

test('a slow verified existing service is reused instead of opening the database twice', async () => {
  const f = await fixture('throw new Error("must not spawn")')
  const { createHash } = await import('node:crypto')
  const instanceId = createHash('sha256').update(path.resolve(f.data).toLowerCase()).digest('hex')
  const server = http.createServer((_req, res) => { setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ instanceId, pid: process.pid, version: '1.7.0' })) }, 1800) })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    await fs.writeFile(path.join(f.data, 'service.json'), JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, version: '1.7.0' }))
    assert.match((await f.run()).stdout, /Vehicle Data Management/)
    assert.equal(await fs.access(path.join(f.data, 'attempts')).then(() => true, () => false), false)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.clean() }
})

test('missing package metadata still produces a launcher log', async () => {
  const f = await fixture(ready)
  try {
    await fs.rm(path.join(f.root, 'package.json'))
    await assert.rejects(f.run())
    assert.match(await fs.readFile(path.join(f.root, 'launcher.log'), 'utf8'), /package.json/)
  } finally { await f.clean() }
})

test('an unverifiable live process never allows a second database service', async () => {
  const f = await fixture('throw new Error("must not spawn")')
  try {
    await fs.writeFile(path.join(f.data, 'service.json'), JSON.stringify({ pid: process.pid, port: 0 }))
    await assert.rejects(f.run(), error => /could not be verified/.test((error as { stderr: string }).stderr))
    assert.equal(await fs.access(path.join(f.data, 'attempts')).then(() => true, () => false), false)
  } finally { await f.clean() }
})

test('real concurrent launches share one service and skip a port occupied by an unrelated HTTP server', async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-real-concurrent-'))
  const launcher = path.resolve('launcher.mjs')
  const occupied = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  occupied.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => occupied.once('listening', resolve))
  const base = (occupied.address() as { port: number }).port
  const options = { env: { ...process.env, PORT: String(base), VEHICLE_MANAGER_DATA_DIR: data }, windowsHide: true, timeout: 20000 }
  try {
    const results = await Promise.all([execute(process.execPath, [launcher, '--no-browser'], options), execute(process.execPath, [launcher, '--no-browser'], options), execute(process.execPath, [launcher, '--no-browser'], options)])
    const state = JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8')) as { port: number }
    assert.notEqual(state.port, base)
    for (const result of results) assert(result.stdout.includes(`http://127.0.0.1:${state.port}`))
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`)).status, 200)
    assert.equal((await fs.readFile(path.join(data, 'startup.log'), 'utf8')).split('Vehicle Data Management:').length - 1, 1)
  } catch (error) {
    t.diagnostic(await fs.readFile(path.join(data, 'startup.log'), 'utf8').catch(() => 'No startup log'))
    throw error
  } finally {
    await execute(process.execPath, [launcher, '--stop'], options).catch(() => {})
    const deadline = Date.now() + 10000
    while (await fs.access(path.join(data, 'service.json')).then(() => true, () => false)) {
      assert(Date.now() < deadline, 'Service did not stop')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    occupied.closeAllConnections()
    await new Promise<void>(resolve => occupied.close(() => resolve()))
    await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
