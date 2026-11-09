import { parseIntakeFields } from '../shared/intake.js'
import { AppError } from './team.js'
import { loadAiClientConfig } from './ai-config.js'

export async function recognizeLabel(bytes: Buffer, mime: string) {
  const configuration = loadAiClientConfig()
  if (!configuration) throw new AppError('AI_NOT_CONFIGURED', 503)
  const { gatewayUrl: address, deviceToken: token } = configuration
  const url = new URL(address)
  const response = await fetch(new URL('/v1/recognitions', url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: `data:${mime};base64,${bytes.toString('base64')}` }), signal: AbortSignal.timeout(60_000) }).catch(() => { throw new AppError('AI_UNAVAILABLE', 503) })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const errors: Record<string, string> = { AI_PROVIDER_AUTH: 'AI_PROVIDER_AUTH', AI_PROVIDER_BALANCE: 'AI_PROVIDER_BALANCE', AI_MODEL_UNAVAILABLE: 'AI_MODEL_UNAVAILABLE', UNAUTHORIZED: 'AI_DEVICE_UNAUTHORIZED', DAILY_LIMIT: 'AI_DAILY_LIMIT', BUSY: 'AI_BUSY', AI_PROVIDER_RATE_LIMIT: 'AI_BUSY' }
    throw new AppError(errors[body?.error] || 'AI_UNAVAILABLE', 503)
  }
  const body = await response.text()
  if (body.length > 32_000) throw new AppError('AI_INVALID_RESULT', 502)
  try { return parseIntakeFields(JSON.parse(body).fields) } catch { throw new AppError('AI_INVALID_RESULT', 502) }
}
