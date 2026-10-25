export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
export const PHOTO_MAX_DIMENSION = 8192
export const PHOTO_MAX_PIXELS = 24_000_000
export type VehiclePhotoInfo = { mime: 'image/png' | 'image/jpeg'; width: number; height: number }

/** Empty is a deliberate cleared cover; null means invalid/untrusted metadata. */
export function parsePhotoAttachmentId(value: unknown): string | null {
  if (value === undefined || value === '') return ''
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value) ? value : null
}

const dimensions = (width: number, height: number) => width > 0 && height > 0 && width <= PHOTO_MAX_DIMENSION && height <= PHOTO_MAX_DIMENSION && width * height <= PHOTO_MAX_PIXELS
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let result = value
  for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1
  return result >>> 0
})
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let result = 0xffffffff
  for (let index = start; index < end; index++) result = crcTable[(result ^ bytes[index]) & 255] ^ (result >>> 8)
  return (result ^ 0xffffffff) >>> 0
}

function png(bytes: Uint8Array, view: DataView): VehiclePhotoInfo | null {
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null
  let offset = 8, width = 0, height = 0, color = 0, palette = false, idat = false, idatEnded = false, compressedLength = 0
  const compressedPrefix: number[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length
    if (end > bytes.length) return null
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) return null
    if (offset === 8 && type !== 'IHDR') return null
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) return null
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); color = bytes[offset + 17]
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!dimensions(width, height) || !depths[color]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return null
    } else if (type === 'PLTE') {
      if (palette || idat || !length || length % 3 || length > 768 || [0, 4].includes(color)) return null
      palette = true
    } else if (type === 'IDAT') {
      if (idatEnded || (color === 3 && !palette)) return null
      idat = true; compressedLength += length
      for (let index = offset + 8; index < end - 4 && compressedPrefix.length < 2; index++) compressedPrefix.push(bytes[index])
    } else if (type === 'IEND') {
      if (length || !idat || compressedLength < 6 || end !== bytes.length || compressedPrefix.length !== 2) return null
      const [method, flags] = compressedPrefix
      if ((method & 15) !== 8 || method >>> 4 > 7 || (method * 256 + flags) % 31 !== 0 || (flags & 32)) return null
      return { mime: 'image/png', width, height }
    } else {
      // Animation and unknown critical chunks are intentionally unsupported.
      if (['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) return null
      if (idat) idatEnded = true
    }
    offset = end
  }
  return null
}

function jpeg(bytes: Uint8Array, view: DataView): VehiclePhotoInfo | null {
  if (bytes.length < 30 || bytes[0] !== 255 || bytes[1] !== 216) return null
  let offset = 2, width = 0, height = 0, scanned = false, entropy = false, scan = false, quantization = false, huffman = false
  const components = new Set<number>()
  while (offset < bytes.length) {
    if (scan && bytes[offset] !== 255) { entropy = true; offset++; continue }
    if (bytes[offset++] !== 255) return null
    while (offset < bytes.length && bytes[offset] === 255) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]
    if (scan && (marker === 0 || (marker >= 208 && marker <= 215))) { if (marker === 0) entropy = true; continue }
    scan = false
    if (marker === 217) return scanned && entropy && width && height && offset === bytes.length ? { mime: 'image/jpeg', width, height } : null
    if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) return null
    const length = view.getUint16(offset), end = offset + length
    if (length < 2 || end > bytes.length) return null
    if ([192, 193, 194].includes(marker)) {
      if (width || length < 11 || bytes[offset + 2] !== 8) return null
      height = view.getUint16(offset + 3); width = view.getUint16(offset + 5)
      const count = bytes[offset + 7]
      if (!dimensions(width, height) || ![1, 3, 4].includes(count) || length !== 8 + count * 3) return null
      for (let index = 0; index < count; index++) {
        const start = offset + 8 + index * 3, sampling = bytes[start + 1]
        if (components.has(bytes[start]) || !(sampling & 15) || (sampling & 15) > 4 || !(sampling >>> 4) || sampling >>> 4 > 4 || bytes[start + 2] > 3) return null
        components.add(bytes[start])
      }
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return null
    else if (marker === 219) {
      let cursor = offset + 2
      while (cursor < end) {
        const table = bytes[cursor++], precision = table >>> 4
        if (precision > 1 || (table & 15) > 3) return null
        cursor += 64 * (precision + 1)
      }
      if (cursor !== end || length < 67) return null
      quantization = true
    } else if (marker === 196) {
      let cursor = offset + 2
      while (cursor < end) {
        const table = bytes[cursor++]
        if (table >>> 4 > 1 || (table & 15) > 3 || cursor + 16 > end) return null
        let symbols = 0
        for (let index = 0; index < 16; index++) symbols += bytes[cursor++]
        if (!symbols || symbols > 256) return null
        cursor += symbols
      }
      if (cursor !== end || length < 20) return null
      huffman = true
    } else if (marker === 218) {
      if (!width || !quantization || !huffman || length < 8) return null
      const count = bytes[offset + 2], selected = new Set<number>()
      if (!count || count > components.size || length !== 6 + count * 2) return null
      for (let index = 0; index < count; index++) {
        const start = offset + 3 + index * 2, tables = bytes[start + 1]
        if (!components.has(bytes[start]) || selected.has(bytes[start]) || (tables & 15) > 3 || tables >>> 4 > 3) return null
        selected.add(bytes[start])
      }
      scanned = true; scan = true
    } else if (marker === 221 && length !== 4) return null
    offset = end
  }
  return null
}

/** Bounded structural validation, not a full pixel decoder. Browsers still handle decode failure. */
export function inspectVehiclePhoto(bytes: Uint8Array): VehiclePhotoInfo | null {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PHOTO_MAX_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return bytes[0] === 137 ? png(bytes, view) : jpeg(bytes, view)
}
