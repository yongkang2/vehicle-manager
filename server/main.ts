import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp } from './app.js'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { atomicFile } from './sync.js'
import { createServer } from 'node:http'
import { createPresence } from './presence.js'

const directory = fileURLToPath(new URL('.', import.meta.url))
const parent = path.resolve(directory, '..')
const project = path.basename(parent) === 'dist-server' ? path.resolve(parent, '..') : parent
const dataDir = process.env.VEHICLE_MANAGER_DATA_DIR || path.join(project, 'data')
const port = Number(process.env.PORT || 4410)
const controlToken = randomBytes(32).toString('hex')
let closing = false
let presence: ReturnType<typeof createPresence> | undefined
const { app, store, tick, synchronization } = createApp({ dataDir, staticDir: path.join(project, 'dist'), controlToken, presenceToken: () => presence?.token || null, onShutdown: () => { void shutdown() } })
void tick()
const interval = setInterval(() => { void tick() }, 30000).unref()
const stateFile = path.join(dataDir, 'service.json')
const server = createServer(app)
if (process.env.VEHICLE_MANAGER_AUTO_STOP === '1') presence = createPresence(server, () => { void shutdown() })
server.listen(port, '127.0.0.1', () => {
	const actualPort = (server.address() as { port: number }).port
	const state = { pid: process.pid, port: actualPort, instanceId: createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex'), controlToken }
	void atomicFile(stateFile, JSON.stringify(state)).then(() => { console.log(`Vehicle Data Management: http://127.0.0.1:${actualPort}`); process.send?.({ type: 'ready', port: actualPort, instanceId: state.instanceId, pid: process.pid }) }).catch(() => { void shutdown(); process.exitCode = 1 })
})
async function shutdown() {
	if (closing) return
	closing = true; clearInterval(interval)
	presence?.stop()
	server.close(() => {
		void synchronization.settle().finally(async () => {
			store.db.close()
			const state = await fs.readFile(stateFile, 'utf8').then(value => JSON.parse(value) as { pid: number }).catch(() => null)
			if (state?.pid === process.pid) await fs.rm(stateFile, { force: true })
		})
	})
}
process.once('SIGINT', () => { void shutdown() }); process.once('SIGTERM', () => { void shutdown() })
server.on('error', error => { console.error(error.message); clearInterval(interval); presence?.stop(); store.db.close(); process.send?.({ type: 'error' }); process.exitCode = 1 })