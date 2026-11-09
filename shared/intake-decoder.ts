export async function decodeLabelPixels(pixels: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType } = await import('@zxing/library')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 24_000_000 || pixels.length !== width * height * 4) return null
  const grayscale = new Uint8ClampedArray(width * height)
  for (let i = 0; i < grayscale.length; i++) grayscale[i] = (pixels[i * 4] + 2 * pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 4
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(grayscale, width, height)))
  for (const hints of [new Map(), new Map([[DecodeHintType.PURE_BARCODE, true]])]) {
    const reader = new MultiFormatReader(); reader.setHints(hints)
    try { return reader.decodeWithState(bitmap).getText() } catch { /* Try the pure-code path for clean cropped labels. */ }
    finally { reader.reset() }
  }
  return null
}
