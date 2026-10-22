import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp } from './app.js'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { atomicFile } from './sync.js'
import { BrowserPresence, installBrowserPresence } from './browser-presence.js'

const directory = fileURLToPath(new URL('.', import.meta.url))
const parent = path.resolve(directory, '..')
const project = path.basename(parent) === 'dist-server' ? path.resolve(parent, '..') : parent
const dataDir = process.env.VEHICLE_MANAGER_DATA_DIR || path.join(project, 'data')
const port = Number(process.env.PORT || 4410)
const controlToken = randomBytes(32).toString('hex')
const presenceToken = randomBytes(32).toString('hex')
let closing = false
const browserPresence = new BrowserPresence({ onEmpty: () => { console.log('All application pages are closed. Stopping the service.'); void shutdown() } })
const { app, close, tick } = createApp({ dataDir, staticDir: path.join(project, 'dist'), controlToken, presenceToken, browserPresence, onShutdown: () => { void shutdown() } })
void tick()
const interval = setInterval(() => { void tick() }, 30000).unref()
const stateFile = path.join(dataDir, 'service.json')
const server = app.listen(port, '127.0.0.1', () => {
	const actualPort = (server.address() as { port: number }).port
	const state = { pid: process.pid, port: actualPort, instanceId: createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex'), controlToken }
	void atomicFile(stateFile, JSON.stringify(state)).then(() => { if (closing) return; browserPresence.start(); console.log(`Vehicle Data Management: http://127.0.0.1:${actualPort}`); process.send?.({ type: 'ready', port: actualPort, instanceId: state.instanceId, pid: process.pid }) }).catch(() => { void shutdown(); process.exitCode = 1 })
})
const disposePresence = installBrowserPresence(server, browserPresence, { token: presenceToken })
async function shutdown() {
	if (closing) return
	closing = true; clearInterval(interval); browserPresence.stop(); disposePresence()
	server.close(() => {
		void close().finally(async () => {
			const state = await fs.readFile(stateFile, 'utf8').then(value => JSON.parse(value) as { pid: number }).catch(() => null)
			if (state?.pid === process.pid) await fs.rm(stateFile, { force: true })
		})
	})
}
process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
server.on('error', error => { console.error(error.message); clearInterval(interval); browserPresence.stop(); disposePresence(); void close(); process.send?.({ type: 'error' }); process.exitCode = 1 })
