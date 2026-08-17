import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

/**
 * A Safari-safe replacement for page.getTextContent(). pdf.js's own
 * getTextContent() is a thin wrapper around streamTextContent() consumed
 * via `for await (const value of readableStream)` — that relies on
 * ReadableStream's async-iterator protocol, which Safari (even recent
 * versions, e.g. 26.5) doesn't implement, throwing "undefined is not a
 * function" near the readableStream value. TextLayer avoids this by reading
 * the same stream manually with getReader()/.read(), so we do the same
 * here rather than trusting getTextContent() at all.
 */
export async function getTextContentSafely(
  page: PDFPageProxy,
): Promise<TextContent> {
  const stream = page.streamTextContent()
  const reader = stream.getReader()
  const textContent: TextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    textContent.lang ??= value.lang
    Object.assign(textContent.styles, value.styles)
    textContent.items.push(...value.items)
  }

  return textContent
}
