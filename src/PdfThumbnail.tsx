import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { logError } from './errorLog'

// Rendered at a fixed pixel width regardless of the container's actual
// on-screen size — sidesteps having to measure a live DOM size (which can
// still be mid-layout right after the grid's column count/track widths
// change, e.g. when a new card is added), and object-fit: cover lets CSS do
// the actual scale-to-fill-and-crop against whatever size the container
// ends up being. This is higher resolution than any card renders at in
// practice, so it stays sharp when the container is larger too.
const THUMBNAIL_RENDER_WIDTH = 480

/**
 * Renders just page 1 of a PDF, scaled and cropped to fill its container
 * completely (like CSS object-fit: cover) rather than fitting the whole
 * page inside it — a stripped-down sibling of PdfPageViewer without page
 * navigation or the text overlay, since a grid card only needs a quick
 * visual identifier, not a readable/selectable page.
 */
export function PdfThumbnail({ file }: { file: File }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
    let renderTask: ReturnType<import('pdfjs-dist').PDFPageProxy['render']> | null =
      null

    setError(false)

    file.arrayBuffer().then((buffer) => {
      if (cancelled) return
      loadingTask = pdfjsLib.getDocument({ data: buffer })
      loadingTask.promise
        .then((doc) => doc.getPage(1))
        .then(async (page) => {
          if (cancelled) return
          const canvas = canvasRef.current
          if (!canvas) return

          const unscaledViewport = page.getViewport({ scale: 1 })
          const outputScale = window.devicePixelRatio || 1
          const scale = (THUMBNAIL_RENDER_WIDTH / unscaledViewport.width) * outputScale
          const viewport = page.getViewport({ scale })

          const context = canvas.getContext('2d')
          if (!context) return

          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)

          renderTask = page.render({ canvas, canvasContext: context, viewport })
          await renderTask.promise
          renderTask = null
        })
        .catch((err) => {
          if (cancelled) return
          logError('PdfThumbnail:render', err)
          setError(true)
        })
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      void loadingTask?.destroy()
    }
  }, [file])

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-raised">
        <span
          className="material-symbols-outlined text-ink-faint"
          style={{ fontSize: 28 }}
          aria-hidden="true"
        >
          description
        </span>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden bg-surface-raised">
      <canvas ref={canvasRef} className="h-full w-full object-cover" />
    </div>
  )
}
