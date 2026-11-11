import { Diagnostics } from './diagnostics.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp } from './app.js'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { atomicFile } from './sync.js'
import { BrowserPresence, installBrowserPresence } from './browser-presence.js'
import { resolveDataDirectory } from '../shared/data-directory.js'
import { appVersion } from '../shared/version.js'

const directory = fileURLToPath(new URL('.', import.meta.url))
const parent = path.resolve(directory, '..')
const project = path.basename(parent) === 'dist-server' ? path.resolve(parent, '..') : parent
const dataDir = await resolveDataDirectory(project)
const diagnostics = new Diagnostics(dataDir)
process.on('uncaughtExceptionMonitor', error => diagnostics.write('error', 'service.crashed', {}, error))
diagnostics.write('info', 'service.starting')
const port = Number(process.env.PORT || 4410)
const controlToken = randomBytes(32).toString('hex')
const presenceToken = randomBytes(32).toString('hex')
let closing = false
const browserPresence = new BrowserPresence({ onEmpty: () => { console.log('All application pages are closed. Stopping the service.'); void shutdown() } })
const { app, close, tick } = createApp({ dataDir, diagnostics, staticDir: path.join(project, 'dist'), controlToken, presenceToken, browserPresence, onShutdown: () => { void shutdown() } })
const poll = () => { void tick().catch(error => diagnostics.write('error', 'service.poll_failed', {}, error)) }
poll()
const interval = setInterval(poll, 30000).unref()
const stateFile = path.join(dataDir, 'service.json')
const server = app.listen(port, '127.0.0.1', (error?: Error) => {
	// Express 5 also calls this callback on listen errors; the error handler below reports them.
	if (error) return
	const actualPort = (server.address() as { port: number }).port
	const state = { pid: process.pid, port: actualPort, instanceId: createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex'), controlToken, version: appVersion }
	void atomicFile(stateFile, JSON.stringify(state)).then(() => { if (closing) return; browserPresence.start(); diagnostics.write('info', 'service.ready', { port: actualPort }); console.log(`Vehicle Data Management: http://127.0.0.1:${actualPort}`); process.send?.({ type: 'ready', port: actualPort, instanceId: state.instanceId, pid: process.pid }) }).catch(error => { diagnostics.write('error', 'service.state_failed', {}, error); void shutdown(); process.exitCode = 1 })
})
const disposePresence = installBrowserPresence(server, browserPresence, { token: presenceToken })
async function shutdown() {
	if (closing) return
	diagnostics.write('info', 'service.stopping')
	closing = true; clearInterval(interval); browserPresence.stop(); disposePresence()
	server.close(() => {
		void close().then(async () => {
			const state = await fs.readFile(stateFile, 'utf8').then(value => JSON.parse(value) as { pid: number }).catch(() => null)
			if (state?.pid === process.pid) await fs.rm(stateFile, { force: true })
			diagnostics.write('info', 'service.stopped')
		}).catch(error => { diagnostics.write('error', 'service.shutdown_failed', {}, error); process.exitCode = 1 })
	})
}
process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
server.on('error', error => { diagnostics.write('error', 'service.listen_failed', {}, error); clearInterval(interval); browserPresence.stop(); disposePresence(); void close(); process.send?.({ type: 'error', code: (error as NodeJS.ErrnoException).code }); process.exitCode = 1 })
