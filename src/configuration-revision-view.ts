import type { ConfigurationRevisionData } from '../shared/configuration-revisions'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'

export type ConfigurationDifference = { key: string; name: string; before: string; after: string; status: 'added' | 'removed' | 'changed' }
const index = (language: Language) => language === 'zh' ? 1 : 0
export function configurationComponentName(component: { id: string; name: string }, language: Language): string {
  const text = translateBusiness(language)
  return component.id.startsWith('thermal-system:') ? text('thermal') : component.id.startsWith('thermal-components:') ? text('thermalKeyComponents') : component.name
}

export function configurationRevisionText(data: ConfigurationRevisionData, language: Language): string {
  const text = translateBusiness(language), at = index(language)
  const lines = [`${data.vin} · ${data.label}${data.title ? ` · ${data.title}` : ''}`, `${data.actor.name} · ${data.publishedAt}`, data.summary]
  for (const section of data.snapshot.sections) {
    lines.push('', section.label[at])
    if (section.state !== 'installed') { lines.push(`${text(section.state === 'unknown' ? 'configurationUnknown' : 'configurationNotInstalled')}: ${section.reason}`); continue }
    for (const component of section.components) {
      lines.push(configurationComponentName(component, language))
      for (const field of component.fields) lines.push(`  ${field.label[at]}: ${field.state === 'known' ? field.value || '—' : `${text(field.state === 'unknown' ? 'configurationUnknown' : 'configurationNotApplicable')} · ${field.reason}`}`)
    }
  }
  return lines.join('\n')
}

export function compareConfigurationRevisions(before: ConfigurationRevisionData, after: ConfigurationRevisionData, language: Language): ConfigurationDifference[] {
  const at = index(language), text = translateBusiness(language)
  const flatten = (data: ConfigurationRevisionData) => {
    const result = new Map<string, { name: string; value: string; signature: string }>()
    for (const section of data.snapshot.sections) {
      if (section.state !== 'installed') result.set(`${section.typeId}:state`, { name: section.label[at], value: `${text(section.state === 'unknown' ? 'configurationUnknown' : 'configurationNotInstalled')} · ${section.reason}`, signature: JSON.stringify([section.state, section.reason]) })
      for (const component of section.components) for (const field of component.fields) result.set(`${section.typeId}:${component.id}:${field.id}`, { name: `${section.label[at]} · ${configurationComponentName(component, language)} · ${field.label[at]}`, value: field.state === 'known' ? `${text('configurationKnown')} · ${field.value || '—'}` : `${text(field.state === 'unknown' ? 'configurationUnknown' : 'configurationNotApplicable')} · ${field.reason}`, signature: JSON.stringify([field.state, field.value, field.reason]) })
    }
    return result
  }
  const left = flatten(before), right = flatten(after)
  return [...new Set([...left.keys(), ...right.keys()])].flatMap(key => {
    const a = left.get(key), b = right.get(key)
    if (a?.signature === b?.signature) return []
    return [{ key, name: b?.name || a!.name, before: a?.value || '—', after: b?.value || '—', status: !a ? 'added' : !b ? 'removed' : 'changed' }]
  })
}
