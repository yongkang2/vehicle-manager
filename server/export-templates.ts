import { randomUUID } from 'node:crypto'
import { parseExportConfiguration } from '../shared/csv-export.js'
import type { ExportConfiguration, ExportTemplate } from '../shared/csv-export.js'
import { LocalStore } from './store.js'
import { AppError } from './team.js'

const maximumTemplates = 100
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function templateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AppError('INVALID_INPUT')
  return value.trim()
}
function configuration(value: unknown): ExportConfiguration {
  const parsed = parseExportConfiguration(value)
  if (!parsed) throw new AppError('INVALID_INPUT')
  return parsed
}

/** Personal preferences live in this workspace, never in the business outbox. */
export class ExportTemplates {
  constructor(readonly store: LocalStore) {}
  private key(accountId: string): string { return `csvExportTemplates:${accountId}` }
  list(accountId: string): ExportTemplate[] {
    const value = this.store.get<unknown>(this.key(accountId))
    if (value === null) return []
    if (!object(value) || value.version !== 1 || !Array.isArray(value.templates) || value.templates.length > maximumTemplates) throw new AppError('INVALID_INPUT')
    return value.templates.map(item => {
      if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.updated !== 'string' || !Number.isFinite(Date.parse(item.updated))) throw new AppError('INVALID_INPUT')
      return { id: item.id, name: templateName(item.name), configuration: configuration(item.configuration), updated: item.updated }
    })
  }
  private save(accountId: string, templates: ExportTemplate[]): void {
    this.store.assertWritable()
    this.store.set(this.key(accountId), { version: 1, templates })
  }
  create(accountId: string, input: unknown): ExportTemplate {
    if (!object(input) || Object.keys(input).some(key => !['name', 'configuration'].includes(key))) throw new AppError('INVALID_INPUT')
    const name = templateName(input.name), config = configuration(input.configuration)
    let result!: ExportTemplate
    this.store.transaction(() => {
      const templates = this.list(accountId)
      if (templates.length >= maximumTemplates) throw new AppError('EXPORT_TEMPLATE_LIMIT')
      if (templates.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new AppError('EXPORT_TEMPLATE_EXISTS', 409)
      result = { id: randomUUID(), name, configuration: config, updated: new Date().toISOString() }
      this.save(accountId, [...templates, result])
    })
    return result
  }
  update(accountId: string, id: string, input: unknown): ExportTemplate {
    if (!object(input) || !Object.keys(input).length || Object.keys(input).some(key => !['name', 'configuration'].includes(key))) throw new AppError('INVALID_INPUT')
    const name = Object.hasOwn(input, 'name') ? templateName(input.name) : undefined
    const config = Object.hasOwn(input, 'configuration') ? configuration(input.configuration) : undefined
    let result!: ExportTemplate
    this.store.transaction(() => {
      const templates = this.list(accountId), current = templates.find(item => item.id === id)
      if (!current) throw new AppError('EXPORT_TEMPLATE_NOT_FOUND', 404)
      if (name && templates.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new AppError('EXPORT_TEMPLATE_EXISTS', 409)
      result = { ...current, name: name ?? current.name, configuration: config ?? current.configuration, updated: new Date().toISOString() }
      this.save(accountId, templates.map(item => item.id === id ? result : item))
    })
    return result
  }
  remove(accountId: string, id: string): void {
    this.store.transaction(() => {
      const templates = this.list(accountId)
      if (!templates.some(item => item.id === id)) throw new AppError('EXPORT_TEMPLATE_NOT_FOUND', 404)
      this.save(accountId, templates.filter(item => item.id !== id))
    })
  }
}
