import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button, Checkbox, Empty, Input, Space } from 'antd'
import type { InputRef } from 'antd'
import type { FilterDropdownProps } from 'antd/es/table/interface'
import { Search } from 'lucide-react'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'
import { appliedVehicleFilterKeys, matchingVehicleFilterOptions, selectMatchingVehicleFilterValues } from './vehicle-table-filters'
import type { VehicleFilterValue } from './vehicle-table-filters'

type Props = Pick<FilterDropdownProps, 'selectedKeys' | 'setSelectedKeys' | 'confirm'> & {
  options: readonly VehicleFilterValue[]
  language: Language
  columnTitle: string
}

function navigateOptions(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const inputs = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
  const index = inputs.indexOf(event.target as HTMLInputElement)
  if (index < 0) return
  event.preventDefault()
  inputs[(index + (event.key === 'ArrowDown' ? 1 : -1) + inputs.length) % inputs.length].focus()
}

export default function VehicleColumnFilter({ options, language, columnTitle, selectedKeys, setSelectedKeys, confirm }: Props) {
  const [search, setSearch] = useState('')
  const [focusedOption, setFocusedOption] = useState<string>()
  const searchInput = useRef<InputRef>(null)
  const applyButton = useRef<HTMLButtonElement>(null)
  const text = translateBusiness(language)
  const matching = matchingVehicleFilterOptions(options, search)
  const tabStop = matching.some(option => option.key === focusedOption) ? focusedOption : matching[0]?.key
  const selected = selectedKeys.map(String)
  const checked = new Set(selected)

  function tabWithinPopup(event: KeyboardEvent<HTMLDivElement>) {
    // Let Tab move between popup controls before the dropdown handles tabbing out.
    if (event.key !== 'Tab') return
    const boundary = event.shiftKey ? searchInput.current?.input : applyButton.current
    if (event.target !== boundary) event.stopPropagation()
  }

  function apply() {
    setSelectedKeys(appliedVehicleFilterKeys(selected, options))
    confirm()
  }

  return <div onKeyDown={tabWithinPopup}>
    <div className="ant-table-filter-dropdown-search">
      <Input ref={searchInput} autoFocus prefix={<Search size={14} aria-hidden="true" />} placeholder={text('vehicleColumnFilterSearch')} aria-label={text('vehicleColumnFilterSearch')} value={search} onChange={event => setSearch(event.target.value)} />
    </div>
    <div className="vehicle-filter-options" role="group" aria-label={columnTitle} onKeyDown={navigateOptions}>
      {matching.length ? matching.map(({ key, label }) =>
        <Checkbox key={key} checked={checked.has(key)} tabIndex={key === tabStop ? 0 : -1} onFocus={() => setFocusedOption(key)}
          onChange={event => setSelectedKeys(event.target.checked ? [...selected, key] : selected.filter(value => value !== key))}>
          <span title={label}>{label}</span>
        </Checkbox>
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    </div>
    <div className="ant-table-filter-dropdown-btns">
      <Space size={4}>
        <Button type="link" size="small" disabled={!selected.length} onClick={() => { setSelectedKeys([]); setSearch('') }}>{text('vehicleColumnFilterReset')}</Button>
        <Button type="link" size="small" disabled={!matching.length} onClick={() => setSelectedKeys(selectMatchingVehicleFilterValues(selected, matching))}>{text('vehicleColumnFilterSelectAll')}</Button>
      </Space>
      <Button ref={applyButton} type="primary" size="small" onClick={apply}>{text('vehicleColumnFilterApply')}</Button>
    </div>
  </div>
}
