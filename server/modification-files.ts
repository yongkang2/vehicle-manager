import path from 'node:path'
import unzipper from 'unzipper'
import { AppError } from './team.js'
import { MODIFICATION_EXTENSIONS, MODIFICATION_MAX_FILE_BYTES } from '../shared/modifications.js'

export const modificationFileExtensions = MODIFICATION_EXTENSIONS
export const modificationFileMaximumBytes = MODIFICATION_MAX_FILE_BYTES
const cfbMagic = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const invalid = (): never => { throw new AppError('FILE_TYPE_NOT_ALLOWED', 422) }

/** Read only the bounded compound-file allocation and root directory, never streams. */
function compoundRootNames(bytes: Buffer): Set<string> {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(cfbMagic) || bytes.readUInt16LE(28) !== 0xfffe) invalid()
  const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), sectorBytes = 2 ** shift
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || bytes.length < sectorBytes || bytes.length % sectorBytes) invalid()
  const count = bytes.length / sectorBytes - 1, end = 0xfffffffe, free = 0xffffffff
  const sector = (id: number) => { if (!Number.isInteger(id) || id < 0 || id >= count) invalid(); return bytes.subarray((id + 1) * sectorBytes, (id + 2) * sectorBytes) }
  const fatCount = bytes.readUInt32LE(44), fatSectors: number[] = []
  if (!fatCount || fatCount > count) invalid()
  for (let i = 0; i < 109; i++) { const id = bytes.readUInt32LE(76 + i * 4); if (id !== free) fatSectors.push(id) }
  let difat = bytes.readUInt32LE(68)
  const difatSeen = new Set<number>(), difatCount = bytes.readUInt32LE(72)
  if (difatCount > count) invalid()
  for (let i = 0; i < difatCount; i++) {
    if (difatSeen.has(difat)) invalid(); difatSeen.add(difat)
    const data = sector(difat)
    for (let offset = 0; offset < sectorBytes - 4; offset += 4) { const id = data.readUInt32LE(offset); if (id !== free) fatSectors.push(id) }
    difat = data.readUInt32LE(sectorBytes - 4)
  }
  if ((difatCount && difat !== end) || fatSectors.length !== fatCount || new Set(fatSectors).size !== fatCount) invalid()
  const fat = Buffer.concat(fatSectors.map(sector))
  const chain: Buffer[] = [], seen = new Set<number>()
  let current = bytes.readUInt32LE(48)
  while (current !== end) {
    if (seen.has(current) || seen.size >= count || current * 4 + 4 > fat.length) invalid()
    seen.add(current); chain.push(sector(current)); current = fat.readUInt32LE(current * 4)
  }
  const directory = Buffer.concat(chain)
  if (directory.length < 128 || directory[66] !== 5) invalid()
  const names = new Set<string>(), visited = new Set<number>(), pending = [directory.readUInt32LE(76)]
  while (pending.length) {
    const id = pending.pop()!
    if (id === free) continue
    if (visited.has(id) || id * 128 + 128 > directory.length) invalid()
    visited.add(id)
    const entry = directory.subarray(id * 128, id * 128 + 128), length = entry.readUInt16LE(64)
    if (![1, 2].includes(entry[66]) || length < 2 || length > 64 || length % 2 || entry.readUInt16LE(length - 2) !== 0) invalid()
    names.add(entry.subarray(0, length - 2).toString('utf16le'))
    pending.push(entry.readUInt32LE(68), entry.readUInt32LE(72))
  }
  return names
}

function textContent(bytes: Buffer): string {
  const decoded = (encoding: string) => { const value = new TextDecoder(encoding, { fatal: true }).decode(bytes); if (value.includes('\0')) invalid(); return value }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { if (bytes.length % 2) invalid(); return decoded('utf-16le') }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { if (bytes.length % 2) invalid(); return decoded('utf-16be') }
  if (bytes.includes(0) || bytes.subarray(0, 8).equals(cfbMagic) || bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) invalid()
  const controls = [...bytes].filter(value => value < 32 && ![9, 10, 12, 13].includes(value)).length
  if (controls > Math.max(0, bytes.length * 0.01)) invalid()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new TextDecoder('windows-1252').decode(bytes) }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}

/** Structural checks only: original content is never executed, decoded as Office, or extracted. */
export async function validateModificationFile(filename: string, bytes: Buffer): Promise<string> {
  if (typeof filename !== 'string' || !filename || filename.length > 240 || [...filename].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || /[\\/]/.test(filename)) throw new AppError('INVALID_INPUT')
  if (bytes.length > modificationFileMaximumBytes) throw new AppError('FILE_TOO_LARGE', 413)
  const extension = path.extname(filename).toLowerCase()
  if (!(modificationFileExtensions as readonly string[]).includes(extension)) invalid()
  try {
    if (['.docx', '.xlsx', '.zip'].includes(extension)) {
      if (bytes.length < 22 || !(bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) || extension === '.zip' && bytes.subarray(0, 4).equals(Buffer.from('504b0506', 'hex')))) invalid()
      const zip = await unzipper.Open.buffer(bytes)
      if (zip.files.length > 10000 || zip.files.some(entry => entry.path.length > 2048 || entry.offsetToLocalFileHeader < 0 || entry.offsetToLocalFileHeader >= bytes.length || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.compressedSize > bytes.length)) invalid()
      const entries = new Set(zip.files.map(entry => entry.path))
      if (extension !== '.zip' && (!entries.has('[Content_Types].xml') || !entries.has(extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml'))) invalid()
    } else if (['.doc', '.xls', '.msg'].includes(extension)) {
      const names = compoundRootNames(bytes)
      if (extension === '.doc' ? !names.has('WordDocument') : extension === '.xls' ? !names.has('Workbook') && !names.has('Book') : !names.has('__properties_version1.0')) invalid()
    } else if (extension === '.pdf') {
      if (bytes.length < 5 || bytes.subarray(0, 5).toString() !== '%PDF-') invalid()
    } else if (extension === '.7z') {
      if (bytes.length < 32 || !bytes.subarray(0, 6).equals(Buffer.from('377abcaf271c', 'hex')) || crc32(bytes.subarray(12, 32)) !== bytes.readUInt32LE(8)) invalid()
      const offset = bytes.readBigUInt64LE(12), size = bytes.readBigUInt64LE(20)
      if (offset + size > BigInt(bytes.length - 32) || size > BigInt(modificationFileMaximumBytes)) invalid()
      const next = bytes.subarray(32 + Number(offset), 32 + Number(offset + size))
      if (crc32(next) !== bytes.readUInt32LE(28)) invalid()
    } else {
      const value = textContent(bytes)
      if (extension === '.eml') {
        const header = value.split(/\r?\n\r?\n/, 1)[0], lines = header.split(/\r?\n/)
        if (!lines.length || lines.some((line, index) => !(/^[!-9;-~]+:/.test(line) || index > 0 && /^[ \t]/.test(line))) || !lines.some(line => /^(?:From|To|Subject|Date|Message-ID|MIME-Version|Content-Type):/i.test(line))) invalid()
      }
    }
  } catch (error) { if (error instanceof AppError) throw error; invalid() }
  return extension
}
