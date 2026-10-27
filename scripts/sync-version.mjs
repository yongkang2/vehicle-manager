import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
await fs.writeFile(path.join(project, 'shared', 'version.ts'), `// Generated from package.json by scripts/sync-version.mjs.\nexport const appVersion = '${version}'\n`)
