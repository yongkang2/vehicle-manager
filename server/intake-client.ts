import { parseIntakeFields } from '../shared/intake.js'
import { AppError } from './team.js'

export async function recognizeLabel(bytes: Buffer, mime: string) {
  const address = process.env.VEHICLE_AI_GATEWAY_URL, token = process.env.VEHICLE_AI_DEVICE_TOKEN
  if (!address || !token) throw new AppError('AI_NOT_CONFIGURED', 503)
  const url = new URL(address)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AppError('AI_INVALID_CONFIGURATION', 503)
  const response = await fetch(new URL('/v1/recognitions', url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: `data:${mime};base64,${bytes.toString('base64')}` }), signal: AbortSignal.timeout(60_000) }).catch(() => { throw new AppError('AI_UNAVAILABLE', 503) })
  if (!response.ok) throw new AppError('AI_UNAVAILABLE', 503)
  const body = await response.text()
  if (body.length > 32_000) throw new AppError('AI_INVALID_RESULT', 502)
  try { return parseIntakeFields(JSON.parse(body).fields) } catch { throw new AppError('AI_INVALID_RESULT', 502) }
}
