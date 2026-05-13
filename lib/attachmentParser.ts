import OpenAI from 'openai'

const MAX_PDF_PAGES = 5

async function renderPdfToImages(base64: string, filename: string): Promise<string[]> {
  const { createCanvas } = require('canvas') as typeof import('canvas')
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const buffer = Buffer.from(base64, 'base64')
  console.log(`[AttachmentParser] PDF buffer size: ${buffer.length} bytes`)

  const NodeCanvasFactory = {
    create(width: number, height: number) {
      const canvas = createCanvas(Math.ceil(width), Math.ceil(height))
      return { canvas, context: canvas.getContext('2d') }
    },
    reset(obj: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) {
      obj.canvas.width = Math.ceil(width)
      obj.canvas.height = Math.ceil(height)
    },
    destroy(obj: { canvas: ReturnType<typeof createCanvas> }) {
      obj.canvas.width = 0
      obj.canvas.height = 0
    },
  }

  const loadingTask = (pdfjsLib.getDocument as Function)({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
    canvasFactory: NodeCanvasFactory,
  })

  const doc = await loadingTask.promise
  const numPages = Math.min(doc.numPages, MAX_PDF_PAGES)
  console.log(`[AttachmentParser] PDF "${filename}" has ${doc.numPages} pages, rendering ${numPages}`)

  const images: string[] = []

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1.5 })
    console.log(`[AttachmentParser] Rendering page ${i}: ${Math.ceil(viewport.width)}x${Math.ceil(viewport.height)}`)

    const { canvas, context } = NodeCanvasFactory.create(viewport.width, viewport.height)

    // Patch drawImage to silently skip embedded photos that crash node-canvas
    const ctx = context as unknown as CanvasRenderingContext2D & { drawImage: Function }
    const origDrawImage = ctx.drawImage.bind(ctx)
    ctx.drawImage = function (...args: unknown[]) {
      try { origDrawImage(...args) } catch { /* skip embedded photos */ }
    }

    await (page.render as Function)({
      canvasContext: context,
      viewport,
    }).promise

    const pngBase64 = (canvas as ReturnType<typeof createCanvas>).toBuffer('image/png').toString('base64')
    console.log(`[AttachmentParser] Page ${i} rendered, PNG size: ${pngBase64.length} chars`)
    images.push(pngBase64)
    page.cleanup()
  }

  return images
}

async function describePdfWithVision(base64: string, filename: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  let images: string[]
  try {
    images = await renderPdfToImages(base64, filename)
  } catch (e) {
    console.error(`[AttachmentParser] PDF render failed for "${filename}":`, (e as Error).message)
    console.error((e as Error).stack)
    return ''
  }

  if (images.length === 0) return ''

  type ImagePart = { type: 'image_url'; image_url: { url: string; detail: 'high' } }
  const imageParts: ImagePart[] = images.map(img => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${img}`, detail: 'high' },
  }))

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        ...imageParts,
        {
          type: 'text',
          text: 'Extract ALL real estate information visible in these PDF pages. List every property/unit with: address, unit number, rent/price, beds, baths, square footage, availability date, and any notes. If this is a vacancy list or availability sheet, list every row. Return as plain text.',
        },
      ],
    }],
    max_tokens: 2000,
  })

  const content = response.choices[0]?.message?.content?.trim() ?? ''
  // If GPT-4o says it can't read the image, don't store that as content
  const refusalPhrases = ["i'm unable", "i can't", "i cannot", "no text", "no real estate"]
  if (refusalPhrases.some(p => content.toLowerCase().startsWith(p))) {
    console.log(`[AttachmentParser] GPT-4o could not read "${filename}"`)
    return ''
  }
  return content
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      disableFontFace: true,
      verbosity: 0,
    })
    const doc = await loadingTask.promise
    const pages: string[] = []
    const numPages = Math.min(doc.numPages, MAX_PDF_PAGES)
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = content.items
        .filter((item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item)
        .map(item => item.str)
        .join(' ')
      if (text.trim()) pages.push(text.trim())
      page.cleanup()
    }
    return pages.join('\n')
  } catch {
    return ''
  }
}

async function describeImage(base64: string, mimeType: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
        { type: 'text', text: 'Extract all real estate details from this image. Include: address, price, beds, baths, sq ft, neighborhood, building name, available date, agent name, brokerage, and any listing descriptions. Return as plain text. If there are no real estate details visible, say NONE.' },
      ],
    }],
    max_tokens: 800,
  })
  const content = response.choices[0]?.message?.content?.trim() ?? ''
  return content === 'NONE' || content.toLowerCase().includes("i'm unable") || content.toLowerCase().includes("i can't") ? '' : content
}

export async function parseAttachment(
  name: string,
  mimeType: string,
  contentBytes: string // base64
): Promise<string> {
  try {
    const buffer = Buffer.from(contentBytes, 'base64')

    if (/\.docx$/i.test(name) || mimeType.includes('wordprocessingml')) {
      const mammoth = require('mammoth')
      const result = await mammoth.extractRawText({ buffer })
      return result.value?.trim() ?? ''
    }

    if (/\.(xlsx|xls)$/i.test(name) || mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel')) {
      const XLSX = require('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer' })
      return wb.SheetNames.map((n: string) =>
        `[Sheet: ${n}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`
      ).join('\n').trim()
    }

    if (mimeType.startsWith('text/') || /\.(txt|csv|md|json)$/i.test(name)) {
      return buffer.toString('utf-8').trim()
    }

    if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) {
      const textResult = await extractPdfText(buffer)
      console.log(`[AttachmentParser] PDF "${name}" — extracted ${textResult.length} chars`)
      return textResult
    }

    if (mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(name)) {
      return await describeImage(contentBytes, mimeType)
    }

    return ''
  } catch (e) {
    console.error(`[AttachmentParser] Error parsing "${name}":`, (e as Error).message)
    return ''
  }
}
