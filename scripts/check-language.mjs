import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function assertEnglishMetadata(text, label) {
  assert.doesNotMatch(text || '', /\p{Script=Han}/u, `${label} must use English; Chinese text is not allowed in publication metadata.`)
}

function check() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['docs/portable-guide.en.md', '.github/pull_request_template.md']) {
    assertEnglishMetadata(readFileSync(path.join(root, file), 'utf8'), file)
  }
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  if (event.release) {
    assertEnglishMetadata(event.release.name, 'Release title')
    assertEnglishMetadata(event.release.body, 'Release description')
    for (const asset of event.release.assets || []) assertEnglishMetadata(asset.name, 'Release asset name')
  } else {
    if (event.pull_request) {
      assertEnglishMetadata(event.pull_request.title, 'PR title')
      assertEnglishMetadata(event.pull_request.body, 'PR description')
    }
    const range = event.pull_request ? [`${event.pull_request.base.sha}..${event.pull_request.head.sha}`] : ['-1']
    const messages = execFileSync('git', ['log', ...range, '--format=%B'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assertEnglishMetadata(messages, 'Commit messages')
  }
  console.log('Publication language check passed (Chinese-text guard). Use English for all publication metadata.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) check()
