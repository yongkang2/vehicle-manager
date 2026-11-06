import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('branded launcher works after relocation, preserves arguments and propagates failure', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vehicle-launcher-中文 & ' "))
  try {
    const executable = path.join(root, 'Vehicle Manager.exe')
    execFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
      '/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll',
      `/win32icon:${path.resolve('public/vehicle-manager.ico')}`, `/out:${executable}`, path.resolve('scripts/WindowsLauncher.cs'),
    ], { windowsHide: true })
    mkdirSync(path.join(root, 'runtime'))
    copyFileSync(process.execPath, path.join(root, 'runtime', 'node.exe'))
    writeFileSync(path.join(root, 'launcher.mjs'), "import fs from 'node:fs'; fs.writeFileSync('result.json', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));")
    execFileSync(executable, ['--no-browser'], { cwd: os.tmpdir(), timeout: 15000, windowsHide: true })
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'result.json'), 'utf8')), { cwd: root, args: ['--no-browser'] })
    writeFileSync(path.join(root, 'launcher.mjs'), "console.error('Test startup failure'); process.exit(7)")
    assert.throws(() => execFileSync(executable, ['--no-browser'], { cwd: os.tmpdir(), timeout: 15000, windowsHide: true, stdio: 'pipe' }), (error: unknown) => {
      assert.equal((error as { status: number }).status, 1)
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
