import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

export interface PdfMetadata {
  fileName: string
  fileSize: number
  pageCount: number
  pdfVersion?: string
  isLinearized: boolean
  fingerprint?: string
  info: Record<string, unknown>
  metadataXml: string | null
}

export async function extractPdfMetadata(
  file: File,
  preReadBuffer?: ArrayBuffer,
): Promise<PdfMetadata> {
  const buffer = preReadBuffer ?? (await file.arrayBuffer())
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise

  const { info, metadata } = await doc.getMetadata()

  return {
    fileName: file.name,
    fileSize: file.size,
    pageCount: doc.numPages,
    pdfVersion: (info as Record<string, unknown>).PDFFormatVersion as
      | string
      | undefined,
    isLinearized: Boolean((info as Record<string, unknown>).IsLinearized),
    fingerprint: doc.fingerprints?.[0] ?? undefined,
    info: info as Record<string, unknown>,
    metadataXml: metadata?.getRaw() ?? null,
  }
}
