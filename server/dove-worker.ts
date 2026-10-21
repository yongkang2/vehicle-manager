import { parseDove } from './dove-parser.js'

process.once('message', (bytes: Buffer) => {
  void parseDove(bytes).then(result => process.send?.({ ok: true, result })).catch(error => process.send?.({ ok: false, error: error instanceof Error ? error.message : 'DOVE_PARSE_FAILED' })).finally(() => process.disconnect())
})