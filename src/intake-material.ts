export async function prepareIntakeImage(file: File, pageNumber = 1): Promise<{ image: Blob; text: string; pages: number }> {
  if (file.size > 5 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
  if (file.type !== 'application/pdf') return { image: file, text: '', pages: 1 }
  const pdf = await import('pdfjs-dist'), worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdf.GlobalWorkerOptions.workerSrc = worker.default
  const loading = pdf.getDocument({ data: await file.arrayBuffer() })
  const document = await loading.promise
  try {
    if (document.numPages > 100 || pageNumber < 1 || pageNumber > document.numPages) throw new Error('INVALID_PAGE')
    const page = await document.getPage(pageNumber), original = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(original.width, original.height)) })
    const canvas = window.document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
    const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('INVALID_IMAGE')), 'image/png'))
    const content = await page.getTextContent()
    return { image, pages: document.numPages, text: content.items.map(item => 'str' in item ? item.str : '').join(' ').slice(0, 8000) }
  } finally { await loading.destroy() }
}

export async function decodeIntakeImage(url: string): Promise<string | null> {
  const { decodeLabelPixels } = await import('../shared/intake-decoder')
  const image = new Image(); image.src = url
  try {
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 24_000_000) return null
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    return await decodeLabelPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
  }
  catch { return null }
}
