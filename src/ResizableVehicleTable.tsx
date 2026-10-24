import { useId, useRef, useState } from 'react'
import type { HTMLAttributes, KeyboardEvent, PointerEvent } from 'react'
import { Table } from 'antd'
import type { ColumnType, TableProps } from 'antd/es/table'
import type { BusinessRecord } from '../shared/business'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'
import { clampColumnWidth, keyboardColumnWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, resizedColumnWidth } from './table-column-width'
import './ResizableVehicleTable.css'

export type VehicleTableColumn = ColumnType<BusinessRecord> & { key: string; title: string; width: number }
type Props = Omit<TableProps<BusinessRecord>, 'columns' | 'components' | 'scroll' | 'className' | 'tableLayout'> & { columns: VehicleTableColumn[]; language: Language }
type HeaderProps = HTMLAttributes<HTMLTableCellElement> & {
  columnKey: string
  columnWidth: number
  resizeLabel: string
  hintId: string
  onColumnResize: (width: number) => void
  onColumnReset: () => void
}
type Drag = { pointerId: number; startWidth: number; startX: number }

function ResizableHeaderCell({ columnKey, columnWidth, resizeLabel, hintId, onColumnResize, onColumnReset, children, style, ...props }: HeaderProps) {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  function begin(event: PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0 || !event.isPrimary) return
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
    if (!cancelled) onColumnResize(resizedColumnWidth(current.startWidth, current.startX, event.clientX))
    drag.current = null; setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function keyboard(event: KeyboardEvent<HTMLSpanElement>) {
    const width = keyboardColumnWidth(columnWidth, event.key, event.shiftKey)
    if (width === null) return
    event.preventDefault(); event.stopPropagation(); onColumnResize(width)
  }
  return <th {...props} style={style}>
    {children}
    <span className="vehicle-column-resize-handle" data-column-key={columnKey} data-dragging={dragging || undefined} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={resizeLabel} aria-describedby={hintId} aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={columnWidth} title={resizeLabel} onPointerDown={begin} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={() => { drag.current = null; setDragging(false) }} onKeyDown={keyboard} onClick={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onColumnReset() }} />
  </th>
}

const components = { header: { cell: ResizableHeaderCell } }

export default function ResizableVehicleTable({ columns, language, ...props }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const hintId = useId(), text = translateBusiness(language)
  const resizedColumns: ColumnType<BusinessRecord>[] = columns.map(column => {
    const width = widths[column.key] ?? clampColumnWidth(column.width)
    return { ...column, width, align: 'center', onHeaderCell: (current, index) => ({
      ...column.onHeaderCell?.(current, index),
      columnKey: column.key, columnWidth: width, resizeLabel: `${text('resizeColumn')}: ${column.title}`, hintId,
      onColumnResize: (value: number) => setWidths(previous => {
        const nextWidth = clampColumnWidth(value)
        return previous[column.key] === nextWidth ? previous : { ...previous, [column.key]: nextWidth }
      }),
      onColumnReset: () => setWidths(previous => {
        if (!(column.key in previous)) return previous
        const next = { ...previous }; delete next[column.key]; return next
      }),
    }) }
  })
  const totalWidth = resizedColumns.reduce((total, column) => total + Number(column.width), 0)
  return <div className="vehicle-table-region">
    <p id={hintId} className="vehicle-column-resize-hint">{text('vehicleColumnResizeHint')}</p>
    <Table<BusinessRecord> {...props} className="vehicles-table" columns={resizedColumns} components={components} tableLayout="fixed" scroll={{ x: totalWidth }} />
  </div>
}
