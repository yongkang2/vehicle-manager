import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampColumnWidth, keyboardColumnWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, resizedColumnWidth } from '../src/table-column-width.js'
import { translateBusiness } from '../src/business-i18n.js'

test('vehicle column widths have bounded integer dimensions and safely normalize invalid values', () => {
  assert.equal(MIN_COLUMN_WIDTH, 80)
  assert.equal(MAX_COLUMN_WIDTH, 1000)
  for (const [width, expected] of [
    [MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH], [MAX_COLUMN_WIDTH, MAX_COLUMN_WIDTH],
    [0, MIN_COLUMN_WIDTH], [-1, MIN_COLUMN_WIDTH], [-1_000_000, MIN_COLUMN_WIDTH],
    [79.9, MIN_COLUMN_WIDTH], [80.49, 80], [80.5, 81], [219.49, 219], [219.5, 220],
    [999.49, 999], [999.5, MAX_COLUMN_WIDTH], [1000.1, MAX_COLUMN_WIDTH],
    [Number.MAX_SAFE_INTEGER, MAX_COLUMN_WIDTH], [Number.MAX_VALUE, MAX_COLUMN_WIDTH],
    [NaN, MIN_COLUMN_WIDTH], [Infinity, MIN_COLUMN_WIDTH], [-Infinity, MIN_COLUMN_WIDTH],
  ]) assert.equal(clampColumnWidth(width), expected, `width ${width}`)
})

test('pointer resize uses the original drag width and horizontal delta without accumulating movement', () => {
  assert.equal(resizedColumnWidth(220, 400, 400), 220)
  assert.equal(resizedColumnWidth(220, 400, 450), 270)
  assert.equal(resizedColumnWidth(220, 400, 350), 170)
  assert.equal(resizedColumnWidth(220, -400, -350), 270)
  assert.equal(resizedColumnWidth(220, -400, -450), 170)
  assert.equal(resizedColumnWidth(220, 400, 400.49), 220)
  assert.equal(resizedColumnWidth(220, 400, 400.5), 221)
  assert.equal(resizedColumnWidth(220, 400, 399.49), 219)
  assert.equal(resizedColumnWidth(220, 400, 399.5), 220)
  const positions = [500, 1200, 1400, 1000, 500, 300, -1000, -1200, 350, 400]
  const widths = positions.map(position => resizedColumnWidth(220, 400, position))
  assert.deepEqual(widths, [320, 1000, 1000, 820, 320, 120, 80, 80, 170, 220])
  assert.equal(resizedColumnWidth(80, 0, -1), MIN_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(80, 0, 1), 81)
  assert.equal(resizedColumnWidth(1000, 0, 1), MAX_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(1000, 0, -1), 999)
})

test('huge, negative and nonfinite pointer inputs always produce a safe bounded width', () => {
  assert.equal(resizedColumnWidth(220, 0, Number.MAX_SAFE_INTEGER), MAX_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(220, Number.MAX_SAFE_INTEGER, 0), MIN_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(220, -Number.MAX_SAFE_INTEGER, 0), MAX_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(220, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), 220)
  assert.equal(resizedColumnWidth(0, 400, 400), MIN_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(-1000, 0, 100), MIN_COLUMN_WIDTH)
  assert.equal(resizedColumnWidth(2000, 0, -1200), 800)
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(resizedColumnWidth(invalid, 100, 150), MIN_COLUMN_WIDTH)
    assert.equal(resizedColumnWidth(220, invalid, 150), MIN_COLUMN_WIDTH)
    assert.equal(resizedColumnWidth(220, 100, invalid), MIN_COLUMN_WIDTH)
    assert.equal(resizedColumnWidth(220, invalid, invalid), MIN_COLUMN_WIDTH)
  }
  // Even arithmetic overflow must never leak Infinity or NaN into a table style.
  const overflow = resizedColumnWidth(220, -Number.MAX_VALUE, Number.MAX_VALUE)
  assert.equal(overflow, MIN_COLUMN_WIDTH)
  assert(Number.isInteger(overflow))
})

test('keyboard resizing supports normal and shifted steps, boundary keys and clamping', () => {
  assert.equal(keyboardColumnWidth(220, 'ArrowLeft'), 210)
  assert.equal(keyboardColumnWidth(220, 'ArrowRight'), 230)
  assert.equal(keyboardColumnWidth(220, 'ArrowLeft', true), 170)
  assert.equal(keyboardColumnWidth(220, 'ArrowRight', true), 270)
  assert.equal(keyboardColumnWidth(85, 'ArrowLeft'), MIN_COLUMN_WIDTH)
  assert.equal(keyboardColumnWidth(995, 'ArrowRight'), MAX_COLUMN_WIDTH)
  assert.equal(keyboardColumnWidth(100, 'ArrowLeft', true), MIN_COLUMN_WIDTH)
  assert.equal(keyboardColumnWidth(980, 'ArrowRight', true), MAX_COLUMN_WIDTH)
  assert.equal(keyboardColumnWidth(MIN_COLUMN_WIDTH, 'ArrowLeft'), MIN_COLUMN_WIDTH)
  assert.equal(keyboardColumnWidth(MAX_COLUMN_WIDTH, 'ArrowRight'), MAX_COLUMN_WIDTH)
  for (const shiftKey of [false, true]) {
    assert.equal(keyboardColumnWidth(220, 'Home', shiftKey), MIN_COLUMN_WIDTH)
    assert.equal(keyboardColumnWidth(220, 'End', shiftKey), MAX_COLUMN_WIDTH)
  }
})

test('keyboard widths normalize invalid starting values while unrelated keys remain unhandled', () => {
  assert.equal(keyboardColumnWidth(219.5, 'ArrowRight'), 230)
  assert.equal(keyboardColumnWidth(-100, 'ArrowRight'), MIN_COLUMN_WIDTH + 10)
  assert.equal(keyboardColumnWidth(2000, 'ArrowLeft'), MAX_COLUMN_WIDTH - 10)
  for (const width of [NaN, Infinity, -Infinity]) {
    assert.equal(keyboardColumnWidth(width, 'ArrowLeft'), MIN_COLUMN_WIDTH)
    assert.equal(keyboardColumnWidth(width, 'ArrowRight'), MIN_COLUMN_WIDTH + 10)
    assert.equal(keyboardColumnWidth(width, 'Home'), MIN_COLUMN_WIDTH)
    assert.equal(keyboardColumnWidth(width, 'End'), MAX_COLUMN_WIDTH)
  }
  for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Tab', ' ', '', 'arrowleft']) {
    assert.equal(keyboardColumnWidth(220, key), null, key)
    assert.equal(keyboardColumnWidth(220, key, true), null, `shift ${key}`)
    assert.equal(keyboardColumnWidth(NaN, key), null, `invalid width ${key}`)
  }
})

test('vehicle column resize controls have English and Chinese labels', () => {
  const english = translateBusiness('en'), chinese = translateBusiness('zh')
  assert.equal(english('resizeColumn'), 'Resize column')
  assert.equal(chinese('resizeColumn'), '调整列宽')
  assert.equal(english('vehicleColumnResizeHint'), 'Drag header edges to resize. Double-click an edge to reset.')
  assert.equal(chinese('vehicleColumnResizeHint'), '拖动表头边缘调整列宽，双击边缘可恢复默认宽度。')
})
