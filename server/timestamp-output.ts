import { StringDecoder } from 'node:string_decoder'

// Preloaded in the service, so detached launches keep timestamps after the launcher exits.
for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
  const write = stream.write.bind(stream), decoder = new StringDecoder('utf8')
  let lineStart = true
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? decoder.end() + chunk : decoder.write(Buffer.from(chunk))
    const stamped = text.replace(/[^\n]*\n|[^\n]+$/g, part => {
      const prefix = lineStart ? `[${new Date().toISOString()}] [${name}] ` : ''
      lineStart = part.endsWith('\n')
      return prefix + part
    })
    return write(stamped, 'utf8', typeof encoding === 'function' ? encoding : callback)
  }) as typeof stream.write
}

// Node's default fatal-error printer writes directly to stderr, bypassing stream.write.
// Keep fatal exceptions terminal while routing their complete stack through the timestamped stream.
process.once('uncaughtException', error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`, () => process.exit(1))
})
