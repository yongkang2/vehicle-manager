import { createAiGateway } from './ai-gateway.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
const apiKey = process.env.DEEPSEEK_API_KEY || ''
const deviceTokens = (process.env.VEHICLE_AI_DEVICE_TOKENS || '').split(',').map(token => token.trim()).filter(Boolean)
const directory = process.env.VEHICLE_AI_DATA_DIR
if (!directory || !path.isAbsolute(directory)) throw new Error('Set VEHICLE_AI_DATA_DIR to a dedicated absolute directory')
mkdirSync(directory, { recursive: true })
const database = new DatabaseSync(path.join(directory, 'usage.sqlite'))
const app = createAiGateway({ apiKey, deviceTokens, database, dailyLimit: Number(process.env.VEHICLE_AI_DAILY_LIMIT || 100) })
app.listen(Number(process.env.VEHICLE_AI_PORT || 4420), '127.0.0.1', () => console.log('AI gateway listening on loopback; use an HTTPS reverse proxy for remote clients.'))
