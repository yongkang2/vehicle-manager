import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZipArchive } from 'archiver'
import { validateModificationFile } from '../server/modification-files.js'

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new ZipArchive(), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => { archive.on('data', data => chunks.push(data)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const [name, value] of Object.entries(entries)) archive.append(value, { name })
  await archive.finalize(); return completed
}
function compound(name: string): Buffer {
  const bytes = Buffer.alloc(1536)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes)
  bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(0xfffe, 28); bytes.writeUInt16LE(9, 30); bytes.writeUInt16LE(6, 32)
  bytes.writeUInt32LE(1, 44); bytes.writeUInt32LE(1, 48); bytes.writeUInt32LE(4096, 56); bytes.writeUInt32LE(0xfffffffe, 60); bytes.writeUInt32LE(0xfffffffe, 68)
  for (let offset = 76; offset < 512; offset += 4) bytes.writeUInt32LE(0xffffffff, offset)
  bytes.writeUInt32LE(0, 76)
  bytes.fill(0xff, 512, 1024); bytes.writeUInt32LE(0xfffffffd, 512); bytes.writeUInt32LE(0xfffffffe, 516)
  const entry = (index: number, entryName: string, type: number, child: number) => {
    const offset = 1024 + index * 128, encoded = Buffer.from(entryName + '\0', 'utf16le')
    encoded.copy(bytes, offset); bytes.writeUInt16LE(encoded.length, offset + 64); bytes[offset + 66] = type
    for (const position of [68, 72]) bytes.writeUInt32LE(0xffffffff, offset + position)
    bytes.writeUInt32LE(child, offset + 76)
  }
  entry(0, 'Root Entry', 5, 1); entry(1, name, 2, 0xffffffff)
  return bytes
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function sevenZip(): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from('377abcaf271c0004', 'hex').copy(bytes); bytes.writeBigUInt64LE(1n, 20)
  bytes.writeUInt32LE(crc32(bytes.subarray(32)), 28); bytes.writeUInt32LE(crc32(bytes.subarray(12, 32)), 8)
  return bytes
}
const rejection = (code: string) => (error: unknown) => (error as { code?: string }).code === code

test('modification formats accept original opaque bytes and case-insensitive extensions', async () => {
  const docx = await zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>' }), xlsx = await zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' })
  const fixtures = new Map<string, Buffer>([
    ['request.DOC', compound('WordDocument')], ['request.docx', docx], ['notes.TXT', Buffer.from('中文 notes\r\n')],
    ['data.XLS', compound('Workbook')], ['data.xlsx', xlsx], ['drawing.PDF', Buffer.from('%PDF-1.7\nfictional')],
    ['mail.eml', Buffer.from('From: test@example.invalid\r\nSubject: Fictional request\r\n\r\nBody')], ['mail.MSG', compound('__properties_version1.0')],
    ['archive.7z', sevenZip()], ['archive.ZIP', await zip({ 'arbitrary.bin': 'opaque payload' })],
  ])
  for (const [name, bytes] of fixtures) { const original = Buffer.from(bytes); await validateModificationFile(name, bytes); assert.deepEqual(bytes, original) }
  await validateModificationFile('empty.zip', await zip({}))
  await validateModificationFile('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]))
  await validateModificationFile('windows.txt', Buffer.from([0x46, 0xe9, 0x76, 0x72, 0x69, 0x65, 0x72]))
})

test('renamed/corrupt containers and malformed text/mail are rejected without extraction', async () => {
  const genericZip = await zip({ 'file.txt': 'not Office' }), workbook = await zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' })
  for (const [name, bytes] of [
    ['wrong.docx', genericZip], ['wrong.docx', workbook], ['wrong.xlsx', genericZip], ['wrong.doc', compound('Workbook')], ['wrong.msg', compound('WordDocument')],
    ['wrong.xls', compound('__properties_version1.0')], ['wrong.zip', Buffer.from('PK\x03\x04truncated')], ['wrong.eml', Buffer.from('ordinary text')],
    ['wrong.txt', Buffer.from([1, 2, 3, 0])], ['wrong.pdf', Buffer.from('pdf')], ['wrong.7z', Buffer.alloc(33)], ['wrong.png', Buffer.from('irrelevant')],
  ] as [string, Buffer][]) await assert.rejects(validateModificationFile(name, bytes), rejection('FILE_TYPE_NOT_ALLOWED'), name)
  const loop = compound('WordDocument'); loop.writeUInt32LE(1, 516)
  await assert.rejects(validateModificationFile('cycle.doc', loop), rejection('FILE_TYPE_NOT_ALLOWED'))
  const bad = sevenZip(); bad[32] = 1
  await assert.rejects(validateModificationFile('crc.7z', bad), rejection('FILE_TYPE_NOT_ALLOWED'))
  await assert.rejects(validateModificationFile('../escape.txt', Buffer.from('text')), rejection('INVALID_INPUT'))
  await assert.rejects(validateModificationFile('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1)), rejection('FILE_TOO_LARGE'))
})
