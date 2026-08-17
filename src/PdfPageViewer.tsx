import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { logError } from './errorLog'
import { getTextContentSafely } from './pdfTextContent'

interface PositionedTextItem {
  str: string
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  angleDeg: number
}

function isTextItem(item: TextItem | { type: string }): item is TextItem {
  return 'str' in item
}

/**
 * Lays out text items as absolutely-positioned spans, using the same
 * viewport point-conversion math as pdfDiff.ts. This deliberately avoids
 * pdfjs-dist's own TextLayer, which unconditionally wraps its input in a
 * `new ReadableStream(...)` internally (even when given a plain object) —
 * Safari's ReadableStream/reader implementation chokes on that particular
 * usage ("undefined is not a function" near a readableStream value), so
 * TextLayer can't be used at all there, not even with a non-streamed
 * source. This is a simpler, streams-free replacement: good enough for
 * text selection/copy, without pdf.js's exact glyph-metrics precision.
 */
function layoutTextItems(
  items: (TextItem | { type: string })[],
  viewport: pdfjsLib.PageViewport,
): PositionedTextItem[] {
  const positioned: PositionedTextItem[] = []
  for (const item of items) {
    if (!isTextItem(item) || !item.str.trim()) continue

    const x0 = item.transform[4]
    const y0 = item.transform[5]
    const [vx1, vy1] = viewport.convertToViewportPoint(x0, y0)
    const [vx2, vy2] = viewport.convertToViewportPoint(
      x0 + item.width,
      y0 + item.height,
    )

    // Rotation/skew angle from the text's own transform matrix, combined
    // with the viewport's rotation, so rotated pages/text still align.
    const angleRad = Math.atan2(item.transform[1], item.transform[0])
    const angleDeg = (angleRad * 180) / Math.PI + viewport.rotation

    positioned.push({
      str: item.str,
      left: Math.min(vx1, vx2),
      top: Math.min(vy1, vy2),
      width: Math.abs(vx2 - vx1),
      height: Math.abs(vy2 - vy1),
      fontSize: Math.abs(vy2 - vy1) || 1,
      angleDeg,
    })
  }
  return positioned
}

function PdfPage({
  doc,
  pageNumber,
  containerWidth,
  maxHeight,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  containerWidth: number
  /** Caps the render scale so the page never exceeds this height — used on
   * mobile/tablet where a single tall page would otherwise push the
   * Prev/Next controls off-screen, since there's no independent scroll
   * container around it like there is on desktop. */
  maxHeight?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageWrapperRef = useRef<HTMLDivElement>(null)
  const [textItems, setTextItems] = useState<PositionedTextItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (containerWidth === 0) return
    let cancelled = false
    // pdf.js throws synchronously if a second render starts on a canvas that
    // already has one in flight — without holding onto the RenderTask
    // there's no way to cancel the in-flight one if this effect re-runs
    // (e.g. the container is resized) before the first render finishes.
    let renderTask: ReturnType<
      import('pdfjs-dist').PDFPageProxy['render']
    > | null = null

    doc
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return
        const canvas = canvasRef.current
        const pageWrapper = pageWrapperRef.current
        if (!canvas || !pageWrapper) return

        const unscaledViewport = page.getViewport({ scale: 1 })
        let scale = Math.min(containerWidth / unscaledViewport.width, 2)
        if (maxHeight) {
          scale = Math.min(scale, maxHeight / unscaledViewport.height)
        }
        const viewport = page.getViewport({ scale })

        const context = canvas.getContext('2d')
        if (!context) return

        const outputScale = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        pageWrapper.style.width = `${viewport.width}px`
        pageWrapper.style.height = `${viewport.height}px`
        setTextItems([])

        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform:
            outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        })
        await renderTask.promise
        renderTask = null

        if (cancelled) return

        // Deliberately not page.getTextContent() nor pdfjs-dist's TextLayer
        // — see getTextContentSafely's and layoutTextItems' doc comments.
        const textContent = await getTextContentSafely(page)
        if (cancelled) return

        setTextItems(layoutTextItems(textContent.items, viewport))
      })
      .catch((err) => {
        // A cancelled render rejects its promise by design — that's not a
        // real failure, just this effect's own cleanup firing.
        if (cancelled) return
        logError('PdfPageViewer:renderPage', err)
        setError(err instanceof Error ? err.message : 'Failed to render page.')
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber, containerWidth])

  if (error) {
    return (
      <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {error}
      </p>
    )
  }

  return (
    <div ref={pageWrapperRef} className="relative select-text shadow-md">
      <canvas ref={canvasRef} className="block max-w-full" />
      {textItems.map((item, i) => (
        <span
          key={i}
          className="absolute origin-top-left whitespace-pre text-transparent"
          style={{
            left: item.left,
            top: item.top,
            width: item.width,
            height: item.height,
            fontSize: item.fontSize,
            lineHeight: 1,
            transform:
              item.angleDeg !== 0 ? `rotate(${item.angleDeg}deg)` : undefined,
          }}
        >
          {item.str}
        </span>
      ))}
    </div>
  )
}

// Matches Tailwind's `lg` breakpoint — below it the split-screen detail
// layout collapses to a single stacked column, where showing every page
// pre-rendered in one long scroll (fine on desktop, where the PDF panel is
// pinned in its own fixed pane) would instead compete for scroll with the
// rest of the page. Paging one page at a time keeps that scroll
// unambiguous on a phone.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export function PdfPageViewer({ file }: { file: File }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [docRef, setDocRef] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const isDesktop = useIsDesktop()

  // Navigating pages should always start at the top — on mobile the whole
  // page scrolls (there's no independent scroll container here), so without
  // this, flipping to a new page leaves the viewport wherever it happened
  // to be scrolled to on the previous one.
  useEffect(() => {
    if (!isDesktop) window.scrollTo({ top: 0 })
  }, [pageNumber, isDesktop])

  useEffect(() => {
    let cancelled = false
    // `.destroy()` lives on the PDFDocumentLoadingTask returned by
    // getDocument() itself — NOT on the PDFDocumentProxy that its `.promise`
    // resolves to, which has no destroy method at all. Keep the task, not
    // the resolved doc, so cleanup can actually cancel/release it.
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

    setError(null)
    setDocRef(null)
    setPageNumber(1)

    file.arrayBuffer().then((buffer) => {
      if (cancelled) return
      loadingTask = pdfjsLib.getDocument({ data: buffer })
      loadingTask.promise
        .then((loadedDoc) => {
          if (cancelled) return
          setDocRef(loadedDoc)
        })
        .catch((err) => {
          if (!cancelled) {
            logError('PdfPageViewer:loadDocument', err)
            setError(err instanceof Error ? err.message : 'Failed to render PDF.')
          }
        })
    })

    return () => {
      cancelled = true
      void loadingTask?.destroy()
    }
  }, [file])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setContainerWidth(width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  if (error) {
    return (
      <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {error}
      </p>
    )
  }

  return (
    <div ref={scrollContainerRef} className="lg:flex lg:min-h-full lg:flex-col">
      {docRef && containerWidth > 0 && (
        <>
          {isDesktop ? (
            <div
              className={`flex flex-1 flex-col items-center gap-6 ${
                docRef.numPages === 1 ? 'justify-center' : ''
              }`}
            >
              {Array.from({ length: docRef.numPages }, (_, i) => (
                <PdfPage
                  key={i + 1}
                  doc={docRef}
                  pageNumber={i + 1}
                  containerWidth={containerWidth}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-screen">
                <div className="mx-auto flex justify-center">
                  <PdfPage
                    key={pageNumber}
                    doc={docRef}
                    pageNumber={pageNumber}
                    containerWidth={containerWidth}
                    maxHeight={window.innerHeight * 0.65}
                  />
                </div>
                {docRef.numPages > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                      disabled={pageNumber <= 1}
                      aria-label="Previous page"
                      className="absolute top-1/2 left-2 z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-surface text-ink shadow-[0_0_16px_0_rgba(20,8,70,0.14)] transition-transform active:scale-90 disabled:cursor-not-allowed disabled:opacity-0"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>
                        chevron_backward
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPageNumber((p) => Math.min(docRef.numPages, p + 1))
                      }
                      disabled={pageNumber >= docRef.numPages}
                      aria-label="Next page"
                      className="absolute top-1/2 right-2 z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-surface text-ink shadow-[0_0_16px_0_rgba(20,8,70,0.14)] transition-transform active:scale-90 disabled:cursor-not-allowed disabled:opacity-0"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>
                        chevron_forward
                      </span>
                    </button>
                  </>
                )}
              </div>
              {docRef.numPages > 1 && (
                <span className="text-sm text-ink-muted">
                  Page {pageNumber} of {docRef.numPages}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
