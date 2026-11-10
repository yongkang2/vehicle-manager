import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)
const prefix = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(?:stdout|stderr|launcher)\] /

test('service preload timestamps every line, including fragmented UTF-8 and startup exceptions', async () => {
  const preload = pathToFileURL(path.resolve(import.meta.dirname, '../server/timestamp-output.ts')).href
  const script = `process.stdout.write('first');process.stdout.write(' line\\nsecond\\n');const b=Buffer.from('中文\\n');process.stderr.write(b.subarray(0,1));process.stderr.write(b.subarray(1));throw new Error('Synthetic startup failure')`
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', '--import', preload, '-e', script], { windowsHide: true }), error => {
    const { stdout, stderr } = error as { stdout: string; stderr: string }
    for (const output of [stdout, stderr]) for (const line of output.trimEnd().split('\n')) assert.match(line, prefix, line)
    assert(stdout.includes('first line\n')); assert(stdout.includes('second'))
    assert(stderr.includes('中文')); assert(stderr.includes('Synthetic startup failure'))
    return true
  })
})

test('launcher fallback timestamps every error and stack line before the service can load', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-launcher-timestamp-'))
  try {
    await fs.copyFile(path.resolve(import.meta.dirname, '../launcher.mjs'), path.join(root, 'launcher.mjs'))
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.6.0","type":"module"}')
    await assert.rejects(execute(process.execPath, [path.join(root, 'launcher.mjs'), '--check'], { windowsHide: true }))
    const log = await fs.readFile(path.join(root, 'launcher.log'), 'utf8')
    assert(log.includes('Automatic updates are not supported'))
    for (const line of log.trimEnd().split('\n')) assert.match(line, prefix)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test('detached service keeps timestamping startup.log after its launcher exits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-detached-timestamp-')), data = path.join(root, 'data')
  try {
    const project = path.resolve(import.meta.dirname, '..')
    await fs.mkdir(path.join(root, 'dist-server', 'server'), { recursive: true })
    await fs.mkdir(path.join(root, 'dist-server', 'shared'), { recursive: true })
    for (const name of ['launcher.mjs', 'package.json']) await fs.copyFile(path.join(project, name), path.join(root, name))
    await fs.copyFile(path.join(project, 'dist-server/server/timestamp-output.js'), path.join(root, 'dist-server/server/timestamp-output.js'))
    await fs.copyFile(path.join(project, 'dist-server/shared/data-directory.js'), path.join(root, 'dist-server/shared/data-directory.js'))
    await fs.writeFile(path.join(root, 'dist-server/server/main.js'), `import {createHash} from 'node:crypto'; import path from 'node:path'; const instanceId=createHash('sha256').update(path.resolve(process.env.VEHICLE_MANAGER_DATA_DIR).toLowerCase()).digest('hex'); process.send({type:'ready',port:12345,instanceId}); setTimeout(()=>console.log('Detached output'),250);setTimeout(()=>{throw new Error('Detached failure')},500);`)
    await execute(process.execPath, [path.join(root, 'launcher.mjs'), '--no-browser'], { env: { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: data }, windowsHide: true, timeout: 10000 })
    let log = ''
    const deadline = Date.now() + 10000
    while (!log.includes('Detached failure') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      log = await fs.readFile(path.join(data, 'startup.log'), 'utf8')
    }
    assert(log.includes('Detached output')); assert(log.includes('Detached failure'))
    for (const line of log.trimEnd().split('\n')) assert.match(line, prefix, line)
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})


test('real application launcher starts and stops with timestamped startup output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-real-timestamp-'))
  const launcher = path.resolve(import.meta.dirname, '../launcher.mjs')
  const options = { env: { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: root }, windowsHide: true, timeout: 15000 }
  let started = false
  try {
    await execute(process.execPath, [launcher, '--no-browser'], options); started = true
    const state = JSON.parse(await fs.readFile(path.join(root, 'service.json'), 'utf8')) as { port: number }
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`)).status, 200)
    await execute(process.execPath, [launcher, '--stop'], options)
    const deadline = Date.now() + 10000
    while (await fs.access(path.join(root, 'service.json')).then(() => true, () => false)) {
      assert(Date.now() < deadline, 'Service did not stop')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    started = false
    const log = await fs.readFile(path.join(root, 'startup.log'), 'utf8')
    assert(log.includes('Vehicle Data Management'))
    for (const line of log.trimEnd().split('\n')) assert.match(line, prefix, line)
  } finally {
    if (started) await execute(process.execPath, [launcher, '--stop'], options).catch(() => {})
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
