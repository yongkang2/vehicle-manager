import { useId, useRef, useState } from 'react'
import type { HTMLAttributes, KeyboardEvent, PointerEvent } from 'react'
import { Button, Checkbox, Modal, Space, Table } from 'antd'
import type { ColumnType, TableProps } from 'antd/es/table'
import { ArrowDown, ArrowUp, Columns3, RotateCcw } from 'lucide-react'
import type { BusinessRecord } from '../shared/business'
import { defaultVehicleTablePreferences, vehicleColumnIds } from '../shared/vehicle-table'
import type { VehicleColumnId, VehicleTablePreferences } from '../shared/vehicle-table'
import type { Language } from './i18n'
import type { VehicleTableSaveStatus } from './vehicle-table-preference-session'
import { translateBusiness } from './business-i18n'
import { clampColumnWidth, keyboardColumnWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, resizedColumnWidth } from './table-column-width'
import './ResizableVehicleTable.css'

export type VehicleTableColumn = ColumnType<BusinessRecord> & { key: string; title: string; width: number }
type Props = Omit<TableProps<BusinessRecord>, 'columns' | 'components' | 'scroll' | 'className' | 'tableLayout'> & { columns: VehicleTableColumn[]; language: Language; preferences: VehicleTablePreferences; onPreferencesChange: (next: VehicleTablePreferences) => void; saveStatus: VehicleTableSaveStatus; retry?: () => void }
type HeaderProps = HTMLAttributes<HTMLTableCellElement> & {
  columnKey: string
  columnWidth: number
  resizeLabel: string
  hintId: string
  resizeDisabled: boolean
  onColumnResize: (width: number) => void
  onColumnResizeEnd: (width: number) => void
  onColumnResizeCancel: () => void
  onColumnReset: () => void
}
type Drag = { pointerId: number; startWidth: number; startX: number }

function ResizableHeaderCell({ columnKey, columnWidth, resizeLabel, hintId, resizeDisabled, onColumnResize, onColumnResizeEnd, onColumnResizeCancel, onColumnReset, children, style, ...props }: HeaderProps) {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  function begin(event: PointerEvent<HTMLSpanElement>) {
    if (resizeDisabled || event.button !== 0 || !event.isPrimary) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startWidth: columnWidth, startX: event.clientX }
    setDragging(true)
  }
  function move(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    event.preventDefault(); event.stopPropagation()
    onColumnResize(resizedColumnWidth(current.startWidth, current.startX, event.clientX))
  }
  function end(event: PointerEvent<HTMLSpanElement>, cancelled = false) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    event.stopPropagation()
    if (!cancelled) onColumnResizeEnd(resizedColumnWidth(current.startWidth, current.startX, event.clientX))
    else onColumnResizeCancel()
    drag.current = null; setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function keyboard(event: KeyboardEvent<HTMLSpanElement>) {
    if (resizeDisabled) return
    const width = keyboardColumnWidth(columnWidth, event.key, event.shiftKey)
    if (width === null) return
    event.preventDefault(); event.stopPropagation(); onColumnResizeEnd(width)
  }
  return <th {...props} style={style}>
    {children}
    <span className="vehicle-column-resize-handle" data-column-key={columnKey} data-dragging={dragging || undefined} role="separator" tabIndex={resizeDisabled ? -1 : 0} aria-disabled={resizeDisabled || undefined} aria-orientation="vertical" aria-label={resizeLabel} aria-describedby={hintId} aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={columnWidth} title={resizeLabel} onPointerDown={begin} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={() => { if (drag.current) onColumnResizeCancel(); drag.current = null; setDragging(false) }} onKeyDown={keyboard} onClick={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (!resizeDisabled) onColumnReset() }} />
  </th>
}

const components = { header: { cell: ResizableHeaderCell } }

export default function ResizableVehicleTable({ columns, language, preferences, onPreferencesChange, saveStatus, retry, ...props }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({}), [columnsOpen, setColumnsOpen] = useState(false)
  const hintId = useId(), text = translateBusiness(language)
  const disabled = saveStatus === 'loading' || saveStatus === 'error'
  const catalog = new Map(columns.map(column => [column.key, column]))
  const clearPreview = (key: string) => setWidths(previous => { if (!(key in previous)) return previous; const next = { ...previous }; delete next[key]; return next })
  const resizedColumns: ColumnType<BusinessRecord>[] = preferences.columns.flatMap(id => {
    const column = catalog.get(id)
    if (!column) return []
    const width = widths[id] ?? preferences.widths[id] ?? clampColumnWidth(column.width)
    return { ...column, width, align: 'center', onHeaderCell: (current, index) => ({
      ...column.onHeaderCell?.(current, index),
      columnKey: id, columnWidth: width, resizeLabel: `${text('resizeColumn')}: ${column.title}`, hintId, resizeDisabled: disabled,
      onColumnResize: (value: number) => setWidths(previous => {
        const nextWidth = clampColumnWidth(value)
        return previous[id] === nextWidth ? previous : { ...previous, [id]: nextWidth }
      }),
      onColumnResizeEnd: (value: number) => { clearPreview(id); onPreferencesChange({ ...preferences, widths: { ...preferences.widths, [id]: clampColumnWidth(value) } }) },
      onColumnResizeCancel: () => clearPreview(id),
      onColumnReset: () => { clearPreview(id); const next = { ...preferences.widths }; delete next[id]; onPreferencesChange({ ...preferences, widths: next }) },
    }) }
  })
  const totalWidth = resizedColumns.reduce((total, column) => total + Number(column.width), 0)
  function toggleColumn(id: string, checked: boolean) {
    if (disabled || id === 'vehicle' || id === 'actions' || !(vehicleColumnIds as readonly string[]).includes(id)) return
    const selected = id as VehicleColumnId
    onPreferencesChange({ ...preferences, columns: checked ? [...preferences.columns.filter(value => value !== selected && value !== 'actions'), selected, 'actions'] : preferences.columns.filter(value => value !== selected) })
  }
  function moveColumn(id: VehicleColumnId, offset: number) {
    const index = preferences.columns.indexOf(id), target = index + offset
    if (disabled || index < 1 || index >= preferences.columns.length - 1 || target < 1 || target >= preferences.columns.length - 1) return
    const next = [...preferences.columns]; [next[index], next[target]] = [next[target], next[index]]
    onPreferencesChange({ ...preferences, columns: next })
  }
  const status = <Space className="vehicle-column-save-status" role="status" aria-live="polite"><span>{text(saveStatus === 'loading' ? 'vehicleTableSettingsLoading' : saveStatus === 'saving' ? 'vehicleTableSettingsSaving' : saveStatus === 'error' ? 'vehicleTableSettingsError' : 'vehicleTableSettingsSaved')}</span>{saveStatus === 'error' && retry && <Button size="small" onClick={retry}>{text('vehicleTableSettingsRetry')}</Button>}</Space>
  return <div className="vehicle-table-region">
    <div className="vehicle-column-toolbar"><p id={hintId} className="vehicle-column-resize-hint">{text('vehicleColumnResizeHint')}</p><Space wrap>{!columnsOpen && status}<Button icon={<Columns3 size={15} />} disabled={disabled} onClick={() => setColumnsOpen(true)}>{text('vehicleTableColumns')}</Button></Space></div>
    <Table<BusinessRecord> {...props} className="vehicles-table" columns={resizedColumns} components={components} tableLayout="fixed" scroll={{ x: totalWidth }} />
    <Modal open={columnsOpen} className="vehicle-column-settings-modal" title={text('vehicleTableColumnsTitle')} onCancel={() => setColumnsOpen(false)} footer={<Button onClick={() => setColumnsOpen(false)}>{text('vehicleTableColumnsClose')}</Button>} width={620} destroyOnHidden>
      <p className="vehicle-column-settings-notice">{text('vehicleTableColumnsNotice')}</p>{status}
      <div className="vehicle-column-settings-toolbar"><h3>{text('vehicleTableShownColumns')}</h3><Button size="small" icon={<RotateCcw size={14} />} disabled={disabled} onClick={() => { setWidths({}); onPreferencesChange(defaultVehicleTablePreferences()) }}>{text('vehicleTableResetColumns')}</Button></div>
      <div className="vehicle-column-settings-list">{preferences.columns.map((id, index) => { const column = catalog.get(id); if (!column) return null; const locked = id === 'vehicle' || id === 'actions'; return <div className="vehicle-column-option" key={id}><Checkbox checked disabled={disabled || locked} onChange={event => toggleColumn(id, event.target.checked)}>{column.title}</Checkbox>{locked ? <span className="vehicle-column-required">{text('vehicleTableAlwaysShown')}</span> : <Space size={4}><Button size="small" icon={<ArrowUp size={14} />} aria-label={`${text('vehicleTableMoveUp')}: ${column.title}`} disabled={disabled || index <= 1} onClick={() => moveColumn(id, -1)} /><Button size="small" icon={<ArrowDown size={14} />} aria-label={`${text('vehicleTableMoveDown')}: ${column.title}`} disabled={disabled || index >= preferences.columns.length - 2} onClick={() => moveColumn(id, 1)} /></Space>}</div> })}</div>
      <h3>{text('vehicleTableAvailableColumns')}</h3><div className="vehicle-column-settings-list">{columns.filter(column => !preferences.columns.includes(column.key as VehicleColumnId)).map(column => <div className="vehicle-column-option" key={column.key}><Checkbox checked={false} disabled={disabled} onChange={event => toggleColumn(column.key, event.target.checked)}>{column.title}</Checkbox></div>)}</div>
    </Modal>
  </div>
}
