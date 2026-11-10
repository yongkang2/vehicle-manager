import { Button, Tag } from 'antd'
import { Pencil } from 'lucide-react'
import type { BusinessRecord } from '../shared/business'
import { thermalSystemTypes } from '../shared/business'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'
import VehiclePhoto from './VehiclePhoto'

type Props = { vehicle: BusinessRecord; language: Language; busy: boolean; onEdit: () => void; onChanged: () => Promise<void>; onError: (cause: unknown) => void; onBusyChange: (busy: boolean) => void }

export default function VehicleOverview({ vehicle, language, busy, onEdit, ...photoProps }: Props) {
  const text = translateBusiness(language)
  const fieldNames = ['name', 'project', 'model', 'vin', 'color', 'plate', 'plateExpiry', 'status', 'physicalLocation', 'owner', 'thermal', 'complianceLevel', ...(vehicle.data.coolingArchitecture ? ['coolingArchitecture'] : []), 'notes']
  function content(key: string) {
    const value = vehicle.data[key]
    if (key === 'status') return <Tag color={{ available: 'green', testing: 'blue', maintenance: 'orange', inactive: 'default' }[String(value)]}>{text(String(value))}</Tag>
    return <span className="preserve-text">{value === undefined || value === null || value === '' ? '—' : key === 'thermal' && thermalSystemTypes.some(type => type === value) ? text(String(value)) : String(value)}</span>
  }
  function fields(keys: string[]) {
    return keys.map(key => <div className={key === 'notes' ? 'vehicle-info-field vehicle-info-field-wide' : 'vehicle-info-field'} key={key}><dt>{text(key === 'name' ? 'nickName' : key)}:</dt><dd>{content(key)}</dd></div>)
  }
  return <section className="vehicle-overview">
    <div className="section-toolbar"><h3>{text('overview')}</h3><Button type="primary" icon={<Pencil size={15} />} disabled={busy || vehicle.archived} onClick={onEdit}>{text('editVehicleDetails')}</Button></div>
    <dl className="vehicle-info-grid">{fields(fieldNames)}</dl>
    <VehiclePhoto vehicle={vehicle} language={language} {...photoProps} />
    <div className="drawer-version">v{vehicle.version} · {new Date(vehicle.updated).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB')}</div>
  </section>
}
