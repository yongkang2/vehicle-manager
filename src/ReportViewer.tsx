import { useState } from 'react'
import { Alert, Button, Descriptions, Input, Modal, Select, Table, Tabs } from 'antd'
import { Search, ScanLine } from 'lucide-react'
import { validReportAssociation } from '../shared/business'
import type { BusinessRecord, Controller, DoveData, Fault, ReportData } from '../shared/business'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'

export default function ReportViewer({ report, record, language }: { report: DoveData; record?: BusinessRecord; language: Language }) {
  const text = translateBusiness(language)
  const association = record && validReportAssociation(record) ? (record.data as unknown as ReportData).association : undefined
  const [controllerQuery, setControllerQuery] = useState(''), [supplier, setSupplier] = useState<string | undefined>()
  const [faultQuery, setFaultQuery] = useState(''), [ecu, setEcu] = useState<string | undefined>(), [status, setStatus] = useState<string | undefined>()
  const [detail, setDetail] = useState<Controller | Fault | null>(null)
  const controllers = report.controllers.map((controller, index) => ({ ...controller, index })).filter(item => (!supplier || item.supplier === supplier) && Object.values(item).join(' ').toLowerCase().includes(controllerQuery.toLowerCase()))
  const faults = report.faults.map((fault, index) => ({ ...fault, index })).filter(item => (!ecu || item.controller === ecu) && (!status || item.status === status) && Object.values(item).join(' ').toLowerCase().includes(faultQuery.toLowerCase()))
  return <div className="report-viewer"><Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} items={[
    { key: 'vin', label: text('sourceVin'), children: <span className="mono">{report.vin || '—'}</span> }, { key: 'date', label: text('recordedAt'), children: report.recordedAt || '—' },
    { key: 'mileage', label: text('mileage'), children: report.mileage === null ? '—' : `${report.mileage} km` }, { key: 'soc', label: 'SOC', children: report.soc === null ? '—' : `${report.soc}%` },
    { key: 'software', label: text('reportSoftware'), children: report.software || '—' }, { key: 'mode', label: text('vehicleMode'), children: report.vehicleMode || '—' },
  ]} />{association && <Alert type="warning" showIcon title={text('manualVehicleWarning')} description={<span>{text('manualVehicleTarget')}: <span className="mono">{association.vin}</span> · {association.actor.name} · {association.assignedAt}</span>} className="report-warning" />}{report.warnings.map(warning => <Alert key={warning} type="warning" showIcon title={text(warning)} className="report-warning" />)}
    <Tabs items={[
      { key: 'controllers', label: `${text('controllers')} (${report.controllers.length})`, children: <><div className="business-filters"><Input prefix={<Search size={15} />} placeholder={text('search')} aria-label={text('controllers')} value={controllerQuery} onChange={event => setControllerQuery(event.target.value)} /><Select allowClear placeholder={text('supplier')} value={supplier} onChange={setSupplier} options={[...new Set(report.controllers.map(item => item.supplier))].filter(Boolean).map(value => ({ value, label: value }))} /></div><Table rowKey="index" dataSource={controllers} size="small" scroll={{ x: 850 }} pagination={{ pageSize: 10, showSizeChanger: true }} columns={[
        { title: text('controller'), dataIndex: 'name', fixed: 'left', width: 110 }, { title: text('supplier'), dataIndex: 'supplier', width: 130 }, { title: text('productPart'), dataIndex: 'productPart', width: 150 }, { title: text('software'), dataIndex: 'software', width: 190 }, { title: text('calibrationVersion'), dataIndex: 'calibrationVersion', width: 130 }, { title: text('details'), width: 80, render: (_, record) => <Button type="text" icon={<ScanLine size={16} />} aria-label={`${text('details')} ${record.name}`} onClick={() => setDetail(record)} /> },
      ]} /></> },
      { key: 'faults', label: `${text('faults')} (${report.faults.length})`, children: <><div className="business-filters"><Input prefix={<Search size={15} />} placeholder={text('search')} aria-label={text('faults')} value={faultQuery} onChange={event => setFaultQuery(event.target.value)} /><Select allowClear placeholder={text('controller')} value={ecu} onChange={setEcu} options={[...new Set(report.faults.map(item => item.controller))].map(value => ({ value, label: value }))} /><Select allowClear placeholder={text('status')} value={status} onChange={setStatus} options={[...new Set(report.faults.map(item => item.status))].map(value => ({ value, label: value }))} /></div><Table rowKey="index" dataSource={faults} size="small" scroll={{ x: 850 }} pagination={{ pageSize: 10, showSizeChanger: true }} columns={[
        { title: 'DTC', dataIndex: 'code', width: 110 }, { title: text('controller'), dataIndex: 'controller', width: 100 }, { title: text('status'), dataIndex: 'status', width: 140 }, { title: text('description'), dataIndex: 'description', width: 360 }, { title: text('details'), width: 80, render: (_, record) => <Button type="text" icon={<ScanLine size={16} />} aria-label={`${text('details')} ${record.code}`} onClick={() => setDetail(record)} /> },
      ]} /></> },
    ]} />
    <Modal open={Boolean(detail)} title={text('details')} onCancel={() => setDetail(null)} footer={null} width={760} destroyOnHidden><Descriptions column={1} size="small" items={Object.entries(detail || {}).filter(([key]) => key !== 'index').map(([key, value]) => ({ key, label: text(key), children: <span className="preserve-text">{String(value || '—')}</span> }))} /></Modal>
  </div>
}
