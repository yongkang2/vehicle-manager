/** Protocol capability and deliberate feature activation are separate after protocol 5. */
export function configurationFeatureFlags(protocol: number, enabled?: unknown, policyEnabled?: unknown): { enabled: boolean; policyEnabled: boolean } {
  const selected = (value: unknown, fallback: boolean) => value === undefined || value === null ? fallback : value === true || value === '1'
  const active = protocol >= 3 && selected(enabled, true)
  return { enabled: active, policyEnabled: active && protocol >= 4 && selected(policyEnabled, true) }
}
