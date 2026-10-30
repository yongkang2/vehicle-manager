import { keyControllerName } from './business.js'
import type { Actor, BusinessRecord, Fields } from './business.js'

export type ConfigurationFieldDefinition = { id: string; label: [string, string]; required: boolean }
export type ComponentTypeDefinition = { id: string; name: string; label: [string, string]; description: string; disabled: boolean; builtin: boolean; version: number; fields: ConfigurationFieldDefinition[]; pendingRestore?: boolean }
export type ComponentTypeCatalog = { enabled: boolean; types: ComponentTypeDefinition[] }
export type ComponentTypeData = { schema: 1; name: string; description: string; disabled: boolean; definitionVersion: number }
export type ConfigurationPreviewField = ConfigurationFieldDefinition & { value: string }
export type ConfigurationPreviewComponent = { id: string; sourceId: string | null; sourceVersion: number; name: string; fields: ConfigurationPreviewField[] }
export type ConfigurationSection = { typeId: string; name: string; label: [string, string]; components: ConfigurationPreviewComponent[] }
export type ConfigurationDecisions = { fields: Record<string, { state: 'unknown' | 'notApplicable'; reason: string }>; sections: Record<string, { state: 'unknown' | 'notInstalled'; reason: string }> }
export type ConfigurationPreview = { token: string; expires: number; vehicleId: string; vin: string; previousRevisionId: string | null; previousNumber: number; sections: ConfigurationSection[] }
export type ConfigurationSnapshotField = ConfigurationPreviewField & { state: 'known' | 'unknown' | 'notApplicable'; reason: string }
export type ConfigurationSnapshotComponent = Omit<ConfigurationPreviewComponent, 'fields'> & { fields: ConfigurationSnapshotField[] }
export type ConfigurationSnapshotSection = Omit<ConfigurationSection, 'components'> & { state: 'installed' | 'unknown' | 'notInstalled'; reason: string; components: ConfigurationSnapshotComponent[] }
export type ConfigurationRevisionData = { schema: 1; name: string; vehicleId: string; vin: string; number: number; label: string; title: string; summary: string; publishedAt: string; actor: Actor; previousRevisionId: string | null; sourceFingerprint: string; snapshot: { schema: 1; sections: ConfigurationSnapshotSection[] } }
export type ConfigurationRevisionRecord = BusinessRecord & { kind: 'configurationRevision'; data: Fields & ConfigurationRevisionData }
export type ConfigurationRevisionSummary = { vehicleId: string; revisionId: string; number: number; label: string; publishedAt: string; actor: Actor; title: string; summary: string; hasChanges: boolean }
export type ConfigurationPublishRequest = { previewToken: string; requestId: string; title: string; summary: string; decisions: ConfigurationDecisions }
export type ConfigurationPublicationReceipt = { requestId: string; revisionId: string; vehicleId: string; number: number; label: string; publishedAt: string; localSynced: boolean }
export type ConfigurationWorkingView = { records: BusinessRecord[]; catalog: ComponentTypeCatalog; revisionSummaries: ConfigurationRevisionSummary[] }
export type ConfigurationReceiptEntry = { key: string; value: string }
export type ConfigurationImport = { id: string; records: BusinessRecord[]; actor: Actor; reason: string; receipts: ConfigurationReceiptEntry[] }

export function validateConfigurationReceiptEntry(entry: ConfigurationReceiptEntry): void {
  if (!entry || typeof entry.key !== 'string' || !/^configurationRequest:[a-f0-9-]{36}$/.test(entry.key) || typeof entry.value !== 'string' || entry.value.length > 100_000) fail()
  let data: unknown
  try { data = JSON.parse(entry.value) } catch { fail() }
  if (!object(data) || typeof data.actorKey !== 'string' || !data.actorKey || typeof data.commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.commandDigest) || !['enable', 'createType', 'updateType', 'publish'].includes(String(data.kind)) || !object(data.receipt) || data.receipt.requestId !== entry.key.slice('configurationRequest:'.length)) fail()
}

const field = (id: string, en: string, zh: string, required = true): ConfigurationFieldDefinition => ({ id, label: [en, zh], required })
export const commonComponentFields = [field('name', 'Name', '名称'), field('position', 'Position', '位置', false), field('productPart', 'Part number', '零件号'), field('serial', 'Serial number', '序列号'), field('maturity', 'Part maturity', '零件成熟度'), field('notes', 'Notes', '说明', false)]
export const builtinComponentTypes: ComponentTypeDefinition[] = [
  { id: 'hv-battery', name: 'HV Battery', label: ['HV Battery', '高压电池'], description: '', disabled: false, builtin: true, version: 1, fields: [field('productPart', 'Part number', '零件号'), field('serial', 'Serial number', '序列号'), field('maturity', 'Part maturity', '零件成熟度'), field('lifeStatus', 'Life Status', '寿命状态')] },
  { id: 'emotor', name: 'eMotor', label: ['eMotor', '电驱电机'], description: '', disabled: false, builtin: true, version: 1, fields: [field('position', 'Position', '位置'), field('productPart', 'Part number', '零件号'), field('serial', 'Serial number', '序列号'), field('maturity', 'Part maturity', '零件成熟度'), field('notes', 'Notes', '说明', false)] },
  { id: 'controllers', name: 'Controllers', label: ['Controllers', '控制器'], description: '', disabled: false, builtin: true, version: 1, fields: [field('name', 'Controller', '控制器'), field('controllerType', 'Type', '类型'), field('functionalPart', 'Functional part number', '功能零件号'), field('productPart', 'Product part number', '产品零件号'), field('serial', 'Serial number', '序列号'), field('software', 'Software identifier / version', '软件标识 / 版本'), field('calibrationPart', 'Calibration part number', '标定零件号'), field('calibrationVersion', 'Calibration version', '标定版本')] },
  { id: 'thermal-management', name: 'Thermal Management', label: ['Thermal Management', '热管理'], description: '', disabled: false, builtin: true, version: 1, fields: [field('name', 'Component', '部件'), field('productPart', 'Part number', '零件号'), field('notes', 'Configuration notes', '配置说明', false)] },
]
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max
const identifier = (value: unknown): value is string => text(value, 120) && Boolean(value.trim())
const fail = (code = 'CONFIGURATION_CORRUPTED'): never => { throw Object.assign(new Error(code), { code }) }
const valueText = (value: unknown) => value === undefined || value === null || typeof value === 'string' && !value.trim() ? '' : String(value)
export const isProtectedKind = (kind: string): kind is 'configurationRevision' | 'componentType' => kind === 'configurationRevision' || kind === 'componentType'
export const configurationRevisionLabel = (number: number) => `R${String(number).padStart(2, '0')}`
export const configurationDecisionKey = (componentId: string, fieldId: string) => `${componentId}:${fieldId}`

export function validateComponentTypeRecord(record: BusinessRecord): ComponentTypeData {
  const data = record.data as unknown as ComponentTypeData
  if (record.kind !== 'componentType' || record.vehicleId !== null || record.archived !== false || !identifier(record.id) || !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isFinite(Date.parse(record.updated)) || !object(data) || data.schema !== 1 || !identifier(data.name) || data.name !== data.name.trim() || !text(data.description) || typeof data.disabled !== 'boolean' || !Number.isSafeInteger(data.definitionVersion) || data.definitionVersion < 1 || builtinComponentTypes.some(type => type.id === record.id)) fail()
  return data
}
export function componentTypeDefinitions(records: readonly BusinessRecord[]): ComponentTypeDefinition[] {
  const result = structuredClone(builtinComponentTypes), names = new Set(result.flatMap(type => [type.name, ...type.label]).map(name => name.toLocaleLowerCase()))
  for (const record of records.filter(row => row.kind === 'componentType').sort((left, right) => left.id.localeCompare(right.id))) {
    const data = validateComponentTypeRecord(record), name = data.name.toLocaleLowerCase()
    if (names.has(name)) fail('COMPONENT_TYPE_EXISTS')
    names.add(name)
    result.push({ id: record.id, name: data.name, label: [data.name, data.name], description: data.description, disabled: data.disabled, builtin: false, version: data.definitionVersion, fields: structuredClone(commonComponentFields) })
  }
  return result
}

/** Read-model copy only: unresolved restores must remain inspectable without changing canonical names or IDs. */
export function pendingComponentTypeView(record: BusinessRecord, occupiedNames: Set<string>): BusinessRecord {
  const data = validateComponentTypeRecord(record)
  let candidate = '', attempt = 0
  do {
    const suffix = ` [pending restore ${record.id.slice(0, 24)}${attempt ? ` ${attempt}` : ''}]`
    candidate = `${data.name.slice(0, 120 - suffix.length)}${suffix}`
    attempt++
  } while (occupiedNames.has(candidate.toLocaleLowerCase()))
  occupiedNames.add(candidate.toLocaleLowerCase())
  return { ...record, data: { ...record.data, name: candidate, disabled: true } }
}

export function configurationSections(records: readonly BusinessRecord[], vehicleId: string, types = componentTypeDefinitions(records), previous?: ConfigurationRevisionData): ConfigurationSection[] {
  const vehicle = records.find(row => row.kind === 'vehicle' && row.id === vehicleId)!
  if (!vehicle) fail('RECORD_NOT_FOUND')
  const active = records.filter(row => row.kind === 'part' && row.vehicleId === vehicleId && !row.archived && !valueText(row.data.removedAt).trim())
  const mapped = (record: BusinessRecord, type: ComponentTypeDefinition): ConfigurationPreviewComponent => ({ id: record.id, sourceId: record.id, sourceVersion: record.version, name: valueText(record.data.name) || type.name, fields: type.fields.map(definition => ({ ...structuredClone(definition), value: definition.id === 'name' && type.id === 'controllers' ? keyControllerName(record.data.name) || valueText(record.data.name) : valueText(record.data[definition.id]) })) })
  return types.filter(type => type.builtin || active.some(row => row.data.category === 'component' && row.data.componentTypeId === type.id) || previous?.snapshot.sections.some(section => section.typeId === type.id)).map(type => {
    const category = type.id === 'hv-battery' ? 'battery' : type.id === 'emotor' ? 'motor' : type.id === 'controllers' ? 'controller' : 'component'
    const components = active.filter(row => row.data.category === category && (category !== 'component' || row.data.componentTypeId === type.id)).sort((left, right) => left.id.localeCompare(right.id)).map(row => mapped(row, type))
    if (type.id === 'thermal-management' && (components.length || valueText(vehicle.data.thermal))) {
      components.unshift({ id: `thermal-system:${vehicleId}`, sourceId: vehicleId, sourceVersion: vehicle.version, name: 'Thermal system', fields: [{ ...field('thermal', 'Thermal System Type', '热管理系统类型'), value: valueText(vehicle.data.thermal) }] })
      if (components.length === 1) components.push({ id: `thermal-components:${vehicleId}`, sourceId: null, sourceVersion: 0, name: 'Key thermal components', fields: [{ ...field('productPart', 'Key component part numbers', '关键部件零件号'), value: '' }] })
    }
    return { typeId: type.id, name: type.name, label: structuredClone(type.label), components }
  })
}
export function configurationSourceFingerprint(sections: readonly ConfigurationSection[]): string {
  return JSON.stringify([...sections].sort((left, right) => left.typeId.localeCompare(right.typeId)).map(section => ({ typeId: section.typeId, components: [...section.components].sort((left, right) => left.id.localeCompare(right.id)).map(component => ({ id: component.id, sourceId: component.sourceId, values: component.fields.map(item => [item.id, item.value]).sort((left, right) => left[0].localeCompare(right[0])) })) })))
}
export function configurationSnapshot(sections: readonly ConfigurationSection[], decisions: ConfigurationDecisions): ConfigurationRevisionData['snapshot'] {
  if (!object(decisions) || !object(decisions.fields) || !object(decisions.sections)) fail('REVISION_INFORMATION_REQUIRED')
  const usedFields = new Set<string>(), usedSections = new Set<string>()
  const result = sections.map(section => {
    if (!section.components.length) {
      const decision = decisions.sections[section.typeId]
      if (!object(decision) || !['unknown', 'notInstalled'].includes(decision.state) || !text(decision.reason, 500) || !decision.reason.trim()) fail('REVISION_INFORMATION_REQUIRED')
      usedSections.add(section.typeId)
      return { ...structuredClone(section), state: decision.state, reason: decision.reason.trim(), components: [] } as ConfigurationSnapshotSection
    }
    return { ...structuredClone(section), state: 'installed', reason: '', components: section.components.map(component => ({ ...structuredClone(component), fields: component.fields.map(item => {
      const key = configurationDecisionKey(component.id, item.id), decision = decisions.fields[key]
      if (item.required && !item.value.trim()) {
        if (!object(decision) || !['unknown', 'notApplicable'].includes(decision.state) || !text(decision.reason, 500) || !decision.reason.trim()) fail('REVISION_INFORMATION_REQUIRED')
        usedFields.add(key)
        return { ...structuredClone(item), state: decision.state, value: '', reason: decision.reason.trim() } as ConfigurationSnapshotField
      }
      return { ...structuredClone(item), state: 'known', reason: '' } as ConfigurationSnapshotField
    }) })) } as ConfigurationSnapshotSection
  })
  if (Object.keys(decisions.fields).some(key => !usedFields.has(key)) || Object.keys(decisions.sections).some(key => !usedSections.has(key))) fail('REVISION_PREVIEW_CHANGED')
  return { schema: 1, sections: result }
}

export function validateConfigurationRevisionRecord(record: BusinessRecord): ConfigurationRevisionData {
  const data = record.data as unknown as ConfigurationRevisionData
  if (record.kind !== 'configurationRevision' || record.archived !== false || !identifier(record.id) || !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isFinite(Date.parse(record.updated)) || !identifier(record.vehicleId) || !object(data) || data.schema !== 1 || data.vehicleId !== record.vehicleId || !/^[A-HJ-NPR-Z0-9]{17}$/.test(data.vin) || !Number.isSafeInteger(data.number) || data.number < 1 || data.label !== configurationRevisionLabel(data.number) || data.name !== data.label || !text(data.title, 120) || !text(data.summary, 500) || !data.summary.trim() || !text(data.publishedAt, 64) || !Number.isFinite(Date.parse(data.publishedAt)) || !object(data.actor) || !identifier(data.actor.id) || !identifier(data.actor.name) || !identifier(data.actor.deviceId) || !['admin', 'member'].includes(data.actor.role) || (data.previousRevisionId !== null && !identifier(data.previousRevisionId)) || !text(data.sourceFingerprint, 4_000_000) || !object(data.snapshot) || data.snapshot.schema !== 1 || !Array.isArray(data.snapshot.sections)) fail()
  const sections = data.snapshot.sections
  if (sections.length < 4 || new Set(sections.map(section => section.typeId)).size !== sections.length || builtinComponentTypes.some(type => !sections.some(section => section.typeId === type.id))) fail()
  const ids = new Set<string>()
  for (const section of sections) {
    if (!object(section) || !identifier(section.typeId) || !identifier(section.name) || !Array.isArray(section.label) || section.label.length !== 2 || section.label.some(label => !identifier(label)) || !['installed', 'unknown', 'notInstalled'].includes(section.state) || !text(section.reason, 500) || !Array.isArray(section.components)) fail()
    if (section.state !== 'installed' && (section.components.length || !section.reason.trim())) fail()
    if (section.state === 'installed' && (!section.components.length || section.reason)) fail()
    for (const component of section.components) {
      if (!object(component) || !identifier(component.id) || ids.has(component.id) || (component.sourceId !== null && !identifier(component.sourceId)) || !Number.isSafeInteger(component.sourceVersion) || component.sourceVersion < 0 || !identifier(component.name) || !Array.isArray(component.fields) || !component.fields.length || new Set(component.fields.map(item => item.id)).size !== component.fields.length) fail()
      ids.add(component.id)
      let expectedFields = (builtinComponentTypes.find(type => type.id === section.typeId)?.fields || commonComponentFields)
      if (section.typeId === 'thermal-management' && component.id === `thermal-system:${record.vehicleId}`) {
        if (component.sourceId !== record.vehicleId) fail()
        expectedFields = [field('thermal', 'Thermal System Type', '热管理系统类型')]
      } else if (section.typeId === 'thermal-management' && component.id === `thermal-components:${record.vehicleId}`) {
        if (component.sourceId !== null || component.sourceVersion !== 0) fail()
        expectedFields = [field('productPart', 'Key component part numbers', '关键部件零件号')]
      } else if (component.sourceId !== component.id || component.sourceVersion < 1) fail()
      if (component.fields.length !== expectedFields.length || expectedFields.some(definition => !component.fields.some(item => item.id === definition.id && item.required === definition.required))) fail()
      for (const item of component.fields) if (!object(item) || !identifier(item.id) || !Array.isArray(item.label) || item.label.length !== 2 || item.label.some(label => !identifier(label)) || typeof item.required !== 'boolean' || !text(item.value) || !['known', 'unknown', 'notApplicable'].includes(item.state) || !text(item.reason, 500) || (item.state === 'known' ? item.required && !item.value.trim() : Boolean(item.value) || !item.reason.trim())) fail()
    }
  }
  if (configurationSourceFingerprint(sections) !== data.sourceFingerprint) fail()
  return data
}
export function validateConfigurationRecords(records: readonly BusinessRecord[]): void {
  const types = componentTypeDefinitions(records), typeIds = new Set(types.map(type => type.id))
  for (const part of records.filter(row => row.kind === 'part' && row.data.category === 'component')) if (!typeIds.has(valueText(part.data.componentTypeId)) || part.data.componentTypeId === 'hv-battery' || part.data.componentTypeId === 'emotor' || part.data.componentTypeId === 'controllers') fail('COMPONENT_TYPE_NOT_FOUND')
  const grouped = new Map<string, ConfigurationRevisionRecord[]>()
  for (const record of records.filter(row => row.kind === 'configurationRevision')) {
    const data = validateConfigurationRevisionRecord(record)
    if (!records.some(vehicle => vehicle.kind === 'vehicle' && vehicle.id === record.vehicleId)) fail()
    if (data.snapshot.sections.some(section => !typeIds.has(section.typeId))) fail('COMPONENT_TYPE_NOT_FOUND')
    const group = grouped.get(record.vehicleId!) || []; group.push(record as ConfigurationRevisionRecord); grouped.set(record.vehicleId!, group)
  }
  for (const group of grouped.values()) {
    group.sort((left, right) => left.data.number - right.data.number)
    for (let index = 0; index < group.length; index++) if (group[index].data.number !== index + 1 || group[index].data.previousRevisionId !== (index ? group[index - 1].id : null)) fail()
  }
}
export function configurationRevisionSummaries(records: readonly BusinessRecord[]): ConfigurationRevisionSummary[] {
  validateConfigurationRecords(records)
  const types = componentTypeDefinitions(records), current = new Map<string, ConfigurationRevisionRecord>()
  for (const record of records.filter(row => row.kind === 'configurationRevision') as ConfigurationRevisionRecord[]) if (!current.has(record.vehicleId!) || current.get(record.vehicleId!)!.data.number < record.data.number) current.set(record.vehicleId!, record)
  return [...current.values()].map(record => ({ vehicleId: record.vehicleId!, revisionId: record.id, number: record.data.number, label: record.data.label, publishedAt: record.data.publishedAt, actor: record.data.actor, title: record.data.title, summary: record.data.summary, hasChanges: configurationSourceFingerprint(configurationSections(records, record.vehicleId!, types, record.data)) !== record.data.sourceFingerprint }))
}
