import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QRCodeWriter, BarcodeFormat } from '@zxing/library'
import { decodeLabelPixels } from '../shared/intake-decoder.js'
test('decodes a generated identifier QR and returns no result for a blank image', async () => {
  const matrix = new QRCodeWriter().encode('TEST0000000000001', BarcodeFormat.QR_CODE, 240, 240, new Map())
  const pixels = new Uint8ClampedArray(240 * 240 * 4)
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const start = (y * 240 + x) * 4; pixels.fill(matrix.get(x, y) ? 0 : 255, start, start + 3); pixels[start + 3] = 255
  }
  assert.equal(await decodeLabelPixels(pixels, 240, 240), 'TEST0000000000001')
  assert.equal(await decodeLabelPixels(new Uint8ClampedArray(240 * 240 * 4).fill(255), 240, 240), null)
})
