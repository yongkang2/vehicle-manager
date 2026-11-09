import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AppError } from './team.js'

export function loadAiClientConfig(environment: NodeJS.ProcessEnv = process.env, file = path.join(environment.LOCALAPPDATA || '', 'VehicleManager', 'ai-client.json')): { gatewayUrl: string; deviceToken: string } | null {
  try {
    let saved: { gatewayUrl?: unknown; deviceToken?: unknown } = {}
    if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const gatewayUrl = environment.VEHICLE_AI_GATEWAY_URL ?? saved.gatewayUrl, deviceToken = environment.VEHICLE_AI_DEVICE_TOKEN ?? saved.deviceToken
    if (!gatewayUrl && !deviceToken) return null
    if (typeof gatewayUrl !== 'string' || typeof deviceToken !== 'string' || deviceToken.length < 32 || /\s/.test(deviceToken)) throw new Error()
    const url = new URL(gatewayUrl)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    return { gatewayUrl: url.origin, deviceToken }
  } catch { throw new AppError('AI_INVALID_CONFIGURATION', 503) }
}
