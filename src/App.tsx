import { useCallback, useEffect, useState } from 'react'
import { Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { extractPdfMetadata, type PdfMetadata } from './pdfMetadata'
import {
  computeFileHash,
  extractPdfSignatures,
  getDocumentVerdict,
  getSignatureVerdict,
  parsePdfDate,
  type CertChainLinkResult,
  type ChainVerificationResult,
  type SignatureInfo,
  type SignatureVerdictReason,
} from './pdfSignatures'
import type { TrustedRootCheckResult } from './trustedRootRegistry'
import {
  checkNotarizedOnNotarity,
  type NotarizedDocumentRecord,
} from './notarityRegistry'
import { PdfPageViewer } from './PdfPageViewer'
import { PdfThumbnail } from './PdfThumbnail'
import { ErrorBoundary } from './ErrorBoundary'
import { hasVisibleTextChanged } from './pdfDiff'

/** Whether the page has been scrolled past the top — used to give sticky
 * nav bars a drop shadow only once there's actually content sliding
 * underneath them, not while they're flush against the very top. */
function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > threshold)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])
  return scrolled
}

const INFO_LABELS: Record<string, string> = {
  Title: 'Title',
  Author: 'Author',
  Subject: 'Subject',
  Keywords: 'Keywords',
  Creator: 'Creator application',
  Producer: 'PDF producer',
  CreationDate: 'Created',
  ModDate: 'Modified',
}

/** Pulls a single RDN attribute (e.g. "CN") out of a flattened
 * "C=AT, O=notarity GmbH, CN=notarity GmbH" subject/issuer string. */
function getRdnField(dn: string, field: string): string | null {
  const m = dn.match(new RegExp(`(?:^|,\\s*)${field}=([^,]+)`))
  return m ? m[1].trim() : null
}

/** True when the cert's CN itself names an organization rather than a
 * person — i.e. the Common Name matches the Organization field (as with a
 * company seal cert). Having an O= field alone isn't enough: a notary's
 * personal cert can carry both O="Notary Public" and a CN that's clearly a
 * person's name. */
function commonNameIsOrganization(dn: string): boolean {
  const cn = getRdnField(dn, 'CN')
  const org = getRdnField(dn, 'O')
  return cn !== null && org !== null && cn.toLowerCase() === org.toLowerCase()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

interface DocState {
  id: string
  file: File
  status: 'loading' | 'ready' | 'error'
  error: string | null
  pdfBytes: Uint8Array | null
  metadata: PdfMetadata | null
  signatures: SignatureInfo[] | null
  fileHash: { algorithm: string; base64: string } | null
}

function makeDocId(): string {
  return `doc-${Math.random().toString(36).slice(2)}`
}

async function loadDocument(id: string, file: File): Promise<DocState> {
  if (file.type !== 'application/pdf') {
    return {
      id,
      file,
      status: 'error',
      error: 'Please upload a PDF file.',
      pdfBytes: null,
      metadata: null,
      signatures: null,
      fileHash: null,
    }
  }
  try {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const [metadataResult, signatureResult, hashResult] = await Promise.all([
      extractPdfMetadata(file, buffer.slice(0)),
      extractPdfSignatures(bytes),
      computeFileHash(bytes),
    ])
    return {
      id,
      file,
      status: 'ready',
      error: null,
      pdfBytes: bytes,
      metadata: metadataResult,
      signatures: signatureResult,
      fileHash: hashResult,
    }
  } catch (err) {
    return {
      id,
      file,
      status: 'error',
      error: err instanceof Error ? err.message : 'Failed to read PDF.',
      pdfBytes: null,
      metadata: null,
      signatures: null,
      fileHash: null,
    }
  }
}

export default function App() {
  const [documents, setDocuments] = useState<DocState[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return

    // Placeholder "loading" rows appear immediately (in drop order) so a
    // batch upload doesn't sit blank while every file is being parsed.
    const ids = files.map(() => makeDocId())
    setDocuments((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: ids[i],
        file,
        status: 'loading' as const,
        error: null,
        pdfBytes: null,
        metadata: null,
        signatures: null,
        fileHash: null,
      })),
    ])

    const loaded = await Promise.all(
      files.map((file, i) => loadDocument(ids[i], file)),
    )
    setDocuments((prev) => {
      const next = [...prev]
      for (const doc of loaded) {
        const idx = next.findIndex((d) => d.id === doc.id)
        if (idx !== -1) next[idx] = doc
      }
      return next
    })
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      setIsDragging(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length > 0) void handleFiles(files)
    },
    [handleFiles],
  )

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length > 0) void handleFiles(files)
      e.target.value = ''
    },
    [handleFiles],
  )

  const anyLoading = documents.some((d) => d.status === 'loading')

  return (
    <div className="min-h-svh bg-surface text-ink">
      <Routes>
        <Route
          path="/"
          element={
            <Dashboard
              documents={documents}
              anyLoading={anyLoading}
              isDragging={isDragging}
              handleFiles={handleFiles}
              onDrop={onDrop}
              onInputChange={onInputChange}
              setIsDragging={setIsDragging}
            />
          }
        />
        <Route
          path="/documents/:id"
          element={<DocumentDetailRoute documents={documents} />}
        />
      </Routes>
    </div>
  )
}

function Dashboard({
  documents,
  anyLoading,
  isDragging,
  handleFiles,
  onDrop,
  onInputChange,
  setIsDragging,
}: {
  documents: DocState[]
  anyLoading: boolean
  isDragging: boolean
  handleFiles: (files: File[]) => void
  onDrop: (e: React.DragEvent<HTMLLabelElement>) => void
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  setIsDragging: (dragging: boolean) => void
}) {
  const navigate = useNavigate()
  const hasDocuments = documents.length > 0

  return (
    <>
      <NavBar />

      <div className="mx-auto max-w-3xl px-6 pt-20 pb-12">
        {hasDocuments ? (
          <div>
            <div className="mb-12 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                Your Documents
              </h1>
              <UploadButton
                multiple
                onFiles={handleFiles}
                label={anyLoading ? 'Reading…' : 'Add more PDFs'}
              />
            </div>

            <DocumentsGrid
              documents={documents}
              onSelect={(id) => navigate(`/documents/${id}`)}
              onDrop={onDrop}
              isDragging={isDragging}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onFiles={handleFiles}
              anyLoading={anyLoading}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center py-10 text-center">
            <span className="text-sm font-medium uppercase tracking-wide text-accent">
              Secure &amp; local verification
            </span>
            <h1 className="mt-2 text-[56px] font-semibold leading-tight tracking-tight text-ink">
              Verify a signed PDF
            </h1>
            <p className="mt-2 max-w-md text-base font-medium text-ink-muted">
              Drop in one or more signed PDFs to check their signatures,
              certificate chains, and notarization status — entirely in your
              browser. Nothing is uploaded anywhere.
            </p>

            <label
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={`group mt-8 w-full cursor-pointer rounded-2xl p-3 transition-colors ${
                isDragging ? 'bg-accent/20' : 'bg-accent/12'
              }`}
            >
              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
                  isDragging
                    ? 'border-accent'
                    : 'border-border-strong group-hover:border-accent'
                }`}
              >
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  onChange={onInputChange}
                />
                <span
                  className="material-symbols-outlined text-accent"
                  style={{ fontSize: 40 }}
                  aria-hidden="true"
                >
                  upload_file
                </span>
                <span className="mt-4 text-sm font-medium text-ink">
                  {anyLoading
                    ? 'Reading PDFs…'
                    : 'Drop PDFs here, or choose files to get started'}
                </span>
                <span className="mt-1 text-xs text-ink-faint">
                  You can select multiple files at once
                </span>
                <span
                  onClick={(e) => e.preventDefault()}
                  className="pointer-events-none mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white shadow-sm transition-colors group-hover:bg-[#140846]"
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 18 }}
                    aria-hidden="true"
                  >
                    upload
                  </span>
                  Select files
                </span>
              </div>
            </label>
          </div>
        )}
      </div>
    </>
  )
}

function DocumentDetailRoute({ documents }: { documents: DocState[] }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const doc = documents.find((d) => d.id === id) ?? null

  // Falls through here on a hard refresh or a directly-pasted URL: the
  // document list only ever lives in memory (nothing is uploaded anywhere),
  // so there's no server to refetch it from — send the user back to the
  // dashboard rather than showing a dead detail page.
  useEffect(() => {
    if (!doc) navigate('/', { replace: true })
  }, [doc, navigate])

  // React Router doesn't reset window scroll on navigation by default —
  // without this, switching documents (or coming back from the dashboard)
  // keeps whatever scroll position the previous detail page was left at.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [id])

  if (!doc) return null

  return <DocumentDetail doc={doc} onBack={() => navigate('/')} />
}

function NavBar() {
  const scrolled = useScrolled()
  return (
    <div
      className={`sticky top-0 z-30 transition-[padding] ${scrolled ? 'px-4 pt-4' : ''}`}
    >
      <div
        className={`mx-auto flex h-20 max-w-3xl items-center bg-surface px-6 transition-all ${
          scrolled
            ? 'h-16 rounded-2xl px-6 shadow-[0_0_24px_0_rgba(20,8,70,0.16)]'
            : ''
        }`}
      >
        <NotarityBrand />
      </div>
    </div>
  )
}

function NotarityBrand({ compactOnMobile }: { compactOnMobile?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <a
        href="https://notarity.com"
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
      >
        {compactOnMobile && (
          <img src="/favicon.svg" alt="notarity" className="h-6 w-6 sm:hidden" />
        )}
        <img
          src="/notarity-logo.svg"
          alt="notarity"
          className={`h-5 w-auto dark:hidden ${compactOnMobile ? 'hidden sm:block' : ''}`}
        />
        <img
          src="/notarity-logo-dark.svg"
          alt="notarity"
          className={`hidden h-5 w-auto dark:block ${compactOnMobile ? 'max-sm:!hidden' : ''}`}
        />
      </a>
      <span className="h-4 w-px bg-border" />
      <span className="text-base font-medium text-ink-muted">
        Signature Validator
      </span>
    </div>
  )
}

function UploadButton({
  onFiles,
  label,
  multiple,
}: {
  onFiles: (files: File[]) => void
  label: string
  multiple?: boolean
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#140846]">
      <input
        type="file"
        accept="application/pdf"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) onFiles(files)
          e.target.value = ''
        }}
      />
      <span
        className="material-symbols-outlined"
        style={{ fontSize: 18 }}
        aria-hidden="true"
      >
        upload
      </span>
      {label}
    </label>
  )
}

function DocumentVerdictBadge({ doc }: { doc: DocState }) {
  if (doc.status === 'loading') {
    return (
      <span className="flex h-8 items-center rounded-full bg-ink-muted/12 px-2 text-base font-medium text-ink-muted">
        Reading…
      </span>
    )
  }
  if (doc.status === 'error') {
    return (
      <span className="flex h-8 items-center rounded-full bg-red-500/12 px-2 text-base font-medium text-red-500">
        Couldn't read
      </span>
    )
  }
  const verdict = doc.signatures ? getDocumentVerdict(doc.signatures) : false
  if (verdict) {
    return (
      <span
        className="flex h-8 items-center gap-1 rounded-full px-2 text-base font-medium text-green-600"
        style={{ backgroundColor: '#E4F5E8' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden="true">
          approval
        </span>
        Validated
      </span>
    )
  }
  return (
    <span
      className="flex h-8 items-center rounded-full px-2 text-base font-medium text-red-500"
      style={{ backgroundColor: '#FFE7E8' }}
    >
      ✗ Not validated
    </span>
  )
}

function NotarizedChip({ doc }: { doc: DocState }) {
  if (doc.status !== 'ready' || !doc.fileHash) return null
  const notarizedRecord = checkNotarizedOnNotarity(doc.fileHash.base64)
  if (!notarizedRecord) return null

  return (
    <span className="flex h-8 items-center rounded-full bg-accent/12 px-2">
      <img src="/favicon.svg" alt="" className="h-4 w-4" />
    </span>
  )
}

function DocumentsGrid({
  documents,
  onSelect,
  onDrop,
  onDragOver,
  onDragLeave,
  isDragging,
  onFiles,
  anyLoading,
}: {
  documents: DocState[]
  onSelect: (id: string) => void
  onDrop: (e: React.DragEvent<HTMLLabelElement>) => void
  onDragOver: (e: React.DragEvent<HTMLLabelElement>) => void
  onDragLeave: () => void
  isDragging: boolean
  onFiles: (files: File[]) => void
  anyLoading: boolean
}) {
  return (
    <div
      className="grid gap-x-16 gap-y-14"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
    >
      {[...documents].reverse().map((doc) => (
        <button
          key={doc.id}
          type="button"
          disabled={doc.status === 'loading'}
          onClick={() => onSelect(doc.id)}
          className="group flex cursor-pointer flex-col items-center text-left disabled:cursor-not-allowed"
        >
          <div className="relative aspect-[210/297] w-full origin-center overflow-hidden rounded-2xl shadow-[0_0_50px_0_rgba(20,8,70,0.12)] transition-all duration-300 ease-out group-hover:scale-[1.02] group-hover:shadow-[0_0_60px_0_rgba(20,8,70,0.18)] group-disabled:group-hover:scale-100 group-disabled:group-hover:shadow-[0_0_50px_0_rgba(20,8,70,0.12)]">
            {doc.status === 'ready' ? (
              <PdfThumbnail file={doc.file} />
            ) : doc.status === 'loading' ? (
              <div className="h-full w-full bg-border" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-surface-raised">
                <span
                  className="material-symbols-outlined text-ink-faint"
                  style={{ fontSize: 28 }}
                  aria-hidden="true"
                >
                  description
                </span>
              </div>
            )}
            <div className="absolute right-4 bottom-4 flex items-center gap-1.5">
              <NotarizedChip doc={doc} />
              <DocumentVerdictBadge doc={doc} />
            </div>
          </div>
          <span className="mt-3 w-full truncate text-center text-base font-medium text-ink-muted">
            {doc.file.name}
          </span>
        </button>
      ))}

      <label
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="group flex cursor-pointer flex-col items-center text-left"
      >
        <input
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) onFiles(files)
            e.target.value = ''
          }}
        />
        <div
          className={`aspect-[210/297] w-full rounded-2xl p-3 transition-colors ${
            isDragging ? 'bg-accent/20' : 'bg-accent/12'
          }`}
        >
          <div
            className={`flex h-full w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
              isDragging
                ? 'border-accent'
                : 'border-border-strong group-hover:border-accent'
            }`}
          >
            <span
              className="material-symbols-outlined text-accent"
              style={{ fontSize: 32 }}
              aria-hidden="true"
            >
              upload_file
            </span>
            <span className="mt-3 text-sm font-medium text-ink">
              {anyLoading ? 'Reading PDFs…' : 'Drop PDFs here'}
            </span>
            <span className="mt-1 text-xs text-ink-faint">
              or click to choose files
            </span>
          </div>
        </div>
        <span className="mt-3 w-full truncate text-center text-base font-medium text-ink-muted">
          &nbsp;
        </span>
      </label>
    </div>
  )
}

/**
 * A vertical history of what happened to the document, most recent first:
 * the overall verdict at the top (feeding into the line, like a headline
 * outcome), each signature as it was applied, and the document's creation
 * at the very bottom — the one entry that isn't a signature event, so it
 * closes the line rather than sitting on it.
 */
function DocumentTimeline({
  signatures,
  allSignatures,
  documentVerdict,
  creationDate,
  pdfBytes,
  notarizedRecord,
}: {
  signatures: SignatureInfo[]
  allSignatures: SignatureInfo[]
  documentVerdict: boolean | null
  creationDate: string | null
  pdfBytes: Uint8Array | null
  notarizedRecord: NotarizedDocumentRecord | null
}) {
  // sortedSignatures is oldest-first (matches signing order); the timeline
  // reads newest-first, so reverse it here rather than changing the sort
  // used elsewhere for the signature cards below.
  const newestFirst = [...signatures].reverse()

  // Same failure list VerdictBanner shows — signatures indexed in signing
  // order (not the timeline's newest-first order), matching the "Signature
  // #N" numbering used everywhere else in the detail view.
  const nonTimestamp = signatures.filter((s) => !s.isTimestamp)
  const failures = nonTimestamp
    .map((sig, i) => ({ sig, position: i, verdict: getSignatureVerdict(sig) }))
    .filter(({ verdict }) => !verdict.isValid)

  return (
    <div className="mb-8">
      {documentVerdict !== null && (
        <div className="relative flex gap-4 pb-4">
          {/* Connects this circle down into the first row's dot — drawn
              here (not on the row) since the row's own segment only
              covers its top half. Spans the whole block's height (title +
              paragraph, whatever that comes out to) via bottom-0 rather
              than a fixed guessed height, so it always reaches the next
              row's line regardless of how many lines the paragraph wraps
              to. */}
          <span className="absolute top-8 bottom-0 left-4 w-0.5 -translate-x-1/2 bg-border-strong" />
          <span
            className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
              documentVerdict ? 'bg-green-600' : 'bg-red-500'
            }`}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 18 }}
              aria-hidden="true"
            >
              {documentVerdict ? 'approval' : 'close'}
            </span>
          </span>
          <div>
            <span className="flex items-center gap-2 text-2xl font-semibold text-ink">
              {documentVerdict && notarizedRecord
                ? 'Validated & Notarized on Notarity'
                : documentVerdict
                  ? 'Validated'
                  : 'Not validated'}
              {documentVerdict && notarizedRecord && (
                <img
                  src="/favicon.svg"
                  alt="Notarized on Notarity"
                  className="h-5 w-5 shrink-0"
                />
              )}
            </span>
            {documentVerdict && notarizedRecord ? (
              <p className="mt-1 text-sm text-ink-muted">
                Every signature in this document is cryptographically valid
                and chains to a trusted root certificate authority. This
                exact document also matches a record of a document created
                and notarized on the notarity platform.
              </p>
            ) : documentVerdict ? (
              <p className="mt-1 text-sm text-ink-muted">
                Every signature in this document is cryptographically valid
                and chains to a trusted root certificate authority.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm text-ink-muted">
                {failures.map(({ sig, position, verdict }) => {
                  const signerLabel = sig.signerName ?? `#${position + 1}`
                  return (
                    <li key={sig.index}>
                      Signature by {signerLabel} not valid because{' '}
                      {verdict.reasons.map((r) => VERDICT_REASON_LABELS[r]).join(', ')}
                      .
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <div>
        {newestFirst.map((sig, i) => (
          <TimelineSignatureRow
            key={sig.index}
            sig={sig}
            isLastSignature={i === 0}
            pdfBytes={pdfBytes}
            allSignatures={allSignatures}
          />
        ))}
        <div className="relative flex items-center gap-4 py-3">
          <span className="absolute top-0 left-4 h-1/2 w-0.5 -translate-x-1/2 bg-border-strong" />
          <div className="relative flex w-8 shrink-0 justify-center">
            <span className="relative z-10 h-2.5 w-2.5 rounded-full bg-ink-faint" />
          </div>
          <span className="text-sm text-ink-muted">
            Document created
            {formatDateTimeLocal(creationDate) &&
              ` - ${formatDateTimeLocal(creationDate)}`}
          </span>
        </div>
      </div>
    </div>
  )
}

function TimelineSignatureRow({
  sig,
  isLastSignature,
  pdfBytes,
  allSignatures,
}: {
  sig: SignatureInfo
  isLastSignature: boolean
  pdfBytes: Uint8Array | null
  allSignatures: SignatureInfo[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [certExpanded, setCertExpanded] = useState(false)
  const [chainExpanded, setChainExpanded] = useState(false)
  const [changes, setChanges] = useState<ChangesSinceResult | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [changesError, setChangesError] = useState<string | null>(null)

  const signerCert = sig.certificateChain[0] ?? null
  const certCommonName = signerCert ? getRdnField(signerCert.subject, 'CN') : null
  const name = certCommonName ?? sig.signerName ?? 'Unknown signer'
  const sigIsValid = getSignatureVerdict(sig).isValid
  const certIsOrganization = signerCert
    ? commonNameIsOrganization(signerCert.subject)
    : false

  const loadChangesSince = useCallback(async () => {
    if (!pdfBytes || !sig.byteRange) return
    setChangesError(null)
    setChangesLoading(true)
    try {
      const [, , s2, l2] = sig.byteRange
      const oldEnd = s2 + l2
      // pdfjsLib.getDocument({ data }) detaches/transfers the buffer backing
      // `data` — pdfBytes is shared state re-used across rows/clicks, so
      // every call here must hand pdf.js an isolated copy, never a view
      // onto pdfBytes' own buffer (which a plain .slice() would still share
      // the ArrayBuffer with).
      const oldBytes = Uint8Array.from(pdfBytes.subarray(0, oldEnd))
      const newBytes = Uint8Array.from(pdfBytes)
      const visibleTextChanged = await hasVisibleTextChanged(oldBytes, newBytes)

      const addedSignatures = allSignatures
        .filter((s) => s.index !== sig.index && s.byteRange)
        .filter((s) => {
          const end = s.byteRange![2] + s.byteRange![3]
          return end > oldEnd
        })
        .sort((a, b) => a.byteRange![2] - b.byteRange![2])

      const explainedGrowth = visibleTextChanged || addedSignatures.length > 0
      const fileGrew = newBytes.length > oldEnd
      const hasUnidentifiedGrowth = fileGrew && !explainedGrowth

      setChanges({ visibleTextChanged, addedSignatures, hasUnidentifiedGrowth })
    } catch (err) {
      setChangesError(
        err instanceof Error ? err.message : 'Failed to compare revisions.',
      )
    } finally {
      setChangesLoading(false)
    }
  }, [pdfBytes, sig, allSignatures])

  // Shown automatically once expanded — no click needed, since it's cheap
  // and the user shouldn't have to ask for it.
  useEffect(() => {
    if (!expanded || isLastSignature || sig.coversWholeFile || !pdfBytes) return
    void loadChangesSince()
    // loadChangesSince is intentionally omitted: including it would re-run
    // this on every pdfBytes-derived recreation of the callback, but we
    // only want this to fire once per row expansion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, isLastSignature, sig.coversWholeFile, pdfBytes])

  return (
    <div className="relative py-3">
      {/* Spans this row's full height (including the py-3 padding) so it
          butts up seamlessly against the previous/next row's own line,
          rather than each row's line only covering its title block and
          leaving a gap at the padding boundaries. */}
      <span className="absolute top-0 bottom-0 left-4 w-0.5 -translate-x-1/2 bg-border-strong" />
      <div className="relative flex items-center gap-4">
        <div className="relative flex w-8 shrink-0 justify-center">
          <span className="relative z-10 h-2.5 w-2.5 rounded-full bg-accent" />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="-ml-2 flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-raised"
        >
          <span className="min-w-0">
            {formatDateTimeLocal(sig.signingTime) && (
              <span className="block text-sm text-ink-muted">
                {formatDateTimeLocal(sig.signingTime)}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="truncate text-2xl font-semibold text-ink">
                {name}
              </span>
              <span
                className={`material-symbols-outlined shrink-0 ${sigIsValid ? 'text-green-600' : 'text-red-500'}`}
                style={{ fontSize: 22 }}
                aria-hidden="true"
              >
                signature
              </span>
              {sig.notary?.isNotary && (
                <span
                  className="material-symbols-outlined shrink-0 text-accent"
                  style={{ fontSize: 22 }}
                  aria-hidden="true"
                >
                  award_star
                </span>
              )}
            </span>
            {sig.notary?.isNotary && (
              <span className="block text-sm text-ink-muted">
                This signer is a notary
                {sig.notary.registryStatus === 'expired'
                  ? ' whose registration has expired'
                  : ''}
                {sig.notary.jurisdiction ? ` in ${sig.notary.jurisdiction}` : ''}
                {sig.notary.registryName
                  ? `, registered with ${sig.notary.registryName}`
                  : ''}
                .
              </span>
            )}
          </span>
          <span
            className={`material-symbols-outlined shrink-0 text-ink-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
            style={{ fontSize: 20 }}
            aria-hidden="true"
          >
            expand_more
          </span>
        </button>
      </div>

      <div className="pl-12">
        {expanded && (
          <dl className="mt-2 grid grid-cols-[30%_1fr] gap-x-6 gap-y-2.5 text-sm">
            <Row
              label={
                certIsOrganization ? 'Signer (from PDF, unverified)' : 'Signer (from PDF)'
              }
              value={sig.signerName ?? '—'}
            />
            <Row label="Signed at" value={formatDateTimeLocal(sig.signingTime) ?? '—'} />
            <Row label="Signature type" value={sig.signatureType} />
            <Row label="Signature level" value={sig.signatureLevel} />
            {sig.signatureAlgorithmName && (
              <Row label="Signature algorithm" value={sig.signatureAlgorithmName} />
            )}
            {sig.reason && <Row label="Reason" value={sig.reason} />}
            {sig.location && <Row label="Location" value={sig.location} />}
            {sig.contactInfo && (
              <Row label="Contact info" value={sig.contactInfo} />
            )}
            <Row
              label="Covers whole file"
              value={sig.coversWholeFile ? 'Yes' : 'No (revised after signing)'}
            />
            {!sig.coversWholeFile && !isLastSignature && (
              <>
                <dt className="text-ink-faint">Changes since this signature</dt>
                <dd className="text-ink">
                  {changesLoading && !changes && (
                    <span className="text-ink-faint">Checking…</span>
                  )}
                  {changesError && <span className="text-red-500">{changesError}</span>}
                  {changes && (
                    <ul className="space-y-1">
                      {changes.visibleTextChanged && (
                        <li>Visible text was added or changed</li>
                      )}
                      {changes.addedSignatures.map((s) => (
                        <li key={s.index}>
                          {s.isTimestamp ? 'Timestamp' : 'Signature'} added
                          {s.signerName ? ` — ${s.signerName}` : ''}
                        </li>
                      ))}
                      {changes.hasUnidentifiedGrowth && (
                        <li>
                          Additional data was added that isn't visible page
                          text
                        </li>
                      )}
                      {!changes.visibleTextChanged &&
                        changes.addedSignatures.length === 0 &&
                        !changes.hasUnidentifiedGrowth && (
                          <li>No changes found after this signature</li>
                        )}
                    </ul>
                  )}
                </dd>
              </>
            )}
          </dl>
        )}

        {expanded && signerCert && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setCertExpanded((e) => !e)}
              className="-ml-2 flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-raised"
            >
              <h4 className="text-base font-semibold text-ink">
                Signer certificate
              </h4>
              <span
                className={`material-symbols-outlined shrink-0 text-ink-faint transition-transform ${certExpanded ? 'rotate-180' : ''}`}
                style={{ fontSize: 20 }}
                aria-hidden="true"
              >
                expand_more
              </span>
            </button>
            {certExpanded && (
              <dl className="mt-2 grid grid-cols-[30%_1fr] gap-x-6 gap-y-2.5 text-sm">
                <Row label="Subject" value={signerCert.subject} mono />
                <Row label="Issuer" value={signerCert.issuer} mono />
                <Row
                  label="Serial number"
                  value={formatSerialNumber(signerCert.serialNumber)}
                  mono
                />
                <Row
                  label="Valid from"
                  value={formatDateTimeLocal(signerCert.validFrom) ?? '—'}
                />
                <Row
                  label="Valid to"
                  value={formatDateTimeLocal(signerCert.validTo) ?? '—'}
                />
                <Row
                  label="Self-signed"
                  value={signerCert.isSelfSigned ? 'Yes (untrusted)' : 'No'}
                />
                {signerCert.keyUsages.length > 0 && (
                  <Row label="Key usage" value={signerCert.keyUsages.join(', ')} />
                )}
                <LinkRow
                  label="Certification policy statement"
                  urls={signerCert.certificatePolicyUrls}
                />
                {signerCert.qualifiedStatements?.isQualified && (
                  <Row
                    label="Certificate quality"
                    value="Qualified certificate (QCStatements present)"
                  />
                )}
                {signerCert.qualifiedStatements?.isQscd && (
                  <Row
                    label="Signature-creation device"
                    value="Qualified (QSCD-backed)"
                  />
                )}
                {qcTypeLabel(signerCert.qualifiedStatements?.qcType ?? null) && (
                  <Row
                    label="Qualified certificate type"
                    value={qcTypeLabel(signerCert.qualifiedStatements?.qcType ?? null)!}
                  />
                )}
                <LinkRow
                  label="PKI disclosure statement"
                  urls={signerCert.qualifiedStatements?.pdsUrls ?? []}
                />
              </dl>
            )}
          </div>
        )}

        {expanded && sig.certificateChain.length > 1 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setChainExpanded((e) => !e)}
              className="-ml-2 flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-raised"
            >
              <span className="flex items-center gap-2">
                <h4 className="text-base font-semibold text-ink">
                  Certificate chain ({sig.certificateChain.length})
                </h4>
                <ChainVerificationBadge
                  result={sig.chainVerification}
                  trustedRoot={sig.trustedRoot}
                />
              </span>
              <span
                className={`material-symbols-outlined shrink-0 text-ink-faint transition-transform ${chainExpanded ? 'rotate-180' : ''}`}
                style={{ fontSize: 20 }}
                aria-hidden="true"
              >
                expand_more
              </span>
            </button>
            {chainExpanded && (
              <div className="mt-2">
                <ul className="space-y-1.5 text-sm text-ink-muted">
                  {sig.certificateChain.map((cert, i) => {
                    const link = sig.chainVerification?.links.find(
                      (l) => l.certIndex === i,
                    )
                    return (
                      <li key={i} className="break-all">
                        {i + 1}. {cert.subject}
                        {cert.isSelfSigned ? (
                          <span className="ml-2">
                            <RootTrustBadge trustedRoot={sig.trustedRoot} />
                          </span>
                        ) : (
                          link && (
                            <span className="ml-2">
                              <ChainLinkBadge link={link} />
                            </span>
                          )
                        )}
                      </li>
                    )
                  })}
                </ul>
                <p className="mt-2 text-sm text-ink-faint">
                  This confirms each certificate was genuinely issued by the
                  next one up the chain, and was valid at signing time.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RootTrustBadge({
  trustedRoot,
}: {
  trustedRoot: TrustedRootCheckResult | null
}) {
  if (trustedRoot?.status === 'trusted') {
    return <span className="text-green-400">✓ Verified root</span>
  }
  return <span className="text-red-400">✗ Root not trusted</span>
}

function DocumentDetail({
  doc,
  onBack,
}: {
  doc: DocState
  onBack: () => void
}) {
  const { file, metadata, signatures, fileHash, pdfBytes } = doc
  const scrolled = useScrolled()

  const knownInfoEntries = metadata
    ? Object.entries(INFO_LABELS)
        .filter(([key]) => metadata.info[key])
        .map(([key, label]) => [
          label,
          key === 'CreationDate' || key === 'ModDate'
            ? (formatDateTimeLocal(parsePdfDate(String(metadata.info[key]))) ??
              String(metadata.info[key]))
            : String(metadata.info[key]),
        ])
    : []

  // Timestamps (RFC 3161 DocTimeStamp) extend a specific signature rather
  // than standing on their own, so they're excluded from the top-level list.
  const topLevelSignatures = signatures
    ? signatures.filter((s) => s.timestampFor === null)
    : []

  const sortedSignatures = [...topLevelSignatures].sort((a, b) => {
    if (!a.signingTime && !b.signingTime) return a.index - b.index
    if (!a.signingTime) return 1
    if (!b.signingTime) return -1
    return (
      new Date(a.signingTime).getTime() - new Date(b.signingTime).getTime()
    )
  })

  const notarizedRecord = fileHash
    ? checkNotarizedOnNotarity(fileHash.base64)
    : null

  const documentVerdict = signatures ? getDocumentVerdict(signatures) : null

  return (
    <div>
      {doc.status === 'error' && (
        <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {doc.error}
        </p>
      )}

      {doc.status === 'loading' && (
        <p className="rounded-lg bg-surface px-4 py-3 text-sm text-ink-muted">
          Reading PDF…
        </p>
      )}

      {doc.status === 'ready' && (
        <>
          <div
            className={`sticky top-0 z-30 transition-[padding] lg:hidden ${scrolled ? 'px-4 pt-4' : ''}`}
          >
            <div
              className={`flex h-20 items-center justify-between gap-4 bg-surface px-6 transition-all ${
                scrolled
                  ? 'h-16 rounded-2xl px-6 shadow-[0_0_24px_0_rgba(20,8,70,0.16)]'
                  : ''
              }`}
            >
              <NotarityBrand compactOnMobile />
              <button
                type="button"
                onClick={onBack}
                className="inline-flex cursor-pointer items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#140846]"
              >
                Dashboard
              </button>
            </div>
          </div>

          <div className="lg:flex">
          <div className="relative lg:fixed lg:top-0 lg:bottom-0 lg:left-0 lg:w-[45%]">
          <div
            className="p-8 lg:h-full lg:overflow-auto"
            style={{ backgroundColor: '#F2F1F6' }}
          >
            <ErrorBoundary
              key={`${file.name}-${file.size}-${file.lastModified}`}
              fallback={(err) => (
                <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  Couldn't render this PDF: {err.message}
                </p>
              )}
            >
              <PdfPageViewer file={file} />
            </ErrorBoundary>
          </div>
          <div className="pointer-events-none absolute right-4 bottom-4 z-10 flex items-center gap-1.5 lg:right-8 lg:bottom-8">
            <NotarizedChip doc={doc} />
            <DocumentVerdictBadge doc={doc} />
          </div>
          </div>

          <div className="lg:ml-[45%] lg:w-[55%]">
          <div
            className={`hidden lg:sticky lg:top-0 lg:z-30 lg:block lg:transition-[padding] ${scrolled ? 'lg:px-4 lg:pt-4' : ''}`}
          >
            <div
              className={`flex h-20 items-center justify-between gap-4 bg-surface px-10 transition-all ${
                scrolled
                  ? 'h-16 rounded-2xl px-6 shadow-[0_0_24px_0_rgba(20,8,70,0.16)]'
                  : ''
              }`}
            >
              <NotarityBrand compactOnMobile />
              <button
                type="button"
                onClick={onBack}
                className="inline-flex cursor-pointer items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#140846]"
              >
                Dashboard
              </button>
            </div>
          </div>
          <div className="px-6 pt-4 pb-10 lg:px-10">
          {signatures && (
            <DocumentTimeline
              signatures={sortedSignatures}
              allSignatures={signatures ?? []}
              documentVerdict={documentVerdict}
              pdfBytes={pdfBytes}
              notarizedRecord={notarizedRecord}
              creationDate={parsePdfDate(
                typeof metadata?.info.CreationDate === 'string'
                  ? metadata.info.CreationDate
                  : null,
              )}
            />
          )}

          {fileHash && notarizedRecord && (
            <div className="mt-6 rounded-xl border border-accent/30 bg-accent/10 p-5">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                <img src="/favicon.svg" alt="" className="h-3.5 w-3.5" />
                Notarity audit trail
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <Row label="Document" value={notarizedRecord.documentTitle} />
                {notarizedRecord.signingEvents.map((event, i) => (
                  <Row
                    key={i}
                    label={
                      notarizedRecord.signingEvents.length > 1
                        ? `Signed by (${i + 1})`
                        : 'Signed by'
                    }
                    value={`${event.signerName} — ${formatDateTimeLocal(event.signedAt) ?? '—'}`}
                  />
                ))}
                <Row
                  label="Notarized by"
                  value={`${notarizedRecord.notary.name} (${notarizedRecord.notary.jurisdiction})`}
                />
                <Row
                  label="Notary registered with"
                  value={notarizedRecord.notary.registryName}
                />
              </dl>
            </div>
          )}

          {(fileHash || metadata) && (
            <div className="mt-10">
              <h2 className="mb-3 text-xl font-semibold tracking-tight text-ink">
                Document details
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {metadata && (
                  <>
                    <Row label="File name" value={metadata.fileName} />
                    <Row
                      label="File size"
                      value={formatBytes(metadata.fileSize)}
                    />
                    <Row label="Pages" value={String(metadata.pageCount)} />
                    {knownInfoEntries.map(([label, value]) => (
                      <Row key={label} label={label} value={String(value)} />
                    ))}
                  </>
                )}
                {fileHash && (
                  <>
                    <Row label="Hash algorithm" value={fileHash.algorithm} />
                    <Row
                      label="Hash (Base64)"
                      value={fileHash.base64}
                      mono
                    />
                  </>
                )}
              </dl>
            </div>
          )}
          </div>
          </div>
          </div>
        </>
      )}
    </div>
  )
}

const URL_PATTERN = /https?:\/\/[^\s()<>]+/g

function linkifyText(value: string): React.ReactNode {
  const matches = [...value.matchAll(URL_PATTERN)]
  if (matches.length === 0) return value

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  matches.forEach((match, i) => {
    const url = match[0]
    const start = match.index
    if (start > lastIndex) parts.push(value.slice(lastIndex, start))
    parts.push(
      <a
        key={i}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline hover:no-underline"
      >
        {url}
      </a>,
    )
    lastIndex = start + url.length
  })
  if (lastIndex < value.length) parts.push(value.slice(lastIndex))
  return parts
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className={`break-all text-ink ${mono ? 'font-mono' : ''}`}>
        {linkifyText(value)}
      </dd>
    </>
  )
}

/** Same as Row, but for one or more URLs — each rendered as its own
 * clickable link opening in a new tab, rather than a plain joined string. */
function LinkRow({ label, urls }: { label: string; urls: string[] }) {
  if (urls.length === 0) return null
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="break-all text-ink">
        {urls.map((url, i) => (
          <span key={url}>
            {i > 0 && ', '}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline hover:no-underline"
            >
              {url}
            </a>
          </span>
        ))}
      </dd>
    </>
  )
}

/** "August 16, 2026 - 14:05", in the reader's own local timezone. */
function formatDateTimeLocal(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const datePart = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const timePart = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${datePart} at ${timePart}`
}

/** Renders a hex serial number (as extracted from the cert's ASN.1 INTEGER)
 * alongside its decimal form, matching how verification reports commonly
 * present it — hex alone doesn't match what's printed on a paper cert or
 * shown by most CA tooling. The hex itself is colon-separated by byte pair
 * (e.g. `39:95:84:...`), the conventional form used by OpenSSL, browsers,
 * and CA tooling alike. */
function formatSerialNumber(hex: string): string {
  if (!hex) return '—'
  try {
    const decimal = BigInt(`0x${hex}`).toString(10)
    // Pad to an even length so pairs align on actual byte boundaries —
    // pdfSignatures.ts strips leading zeros, which can leave an odd count.
    const padded = hex.length % 2 === 0 ? hex : `0${hex}`
    const withColons = padded.match(/.{2}/g)?.join(':') ?? padded
    return `${decimal} (${withColons})`
  } catch {
    return hex
  }
}

const VERDICT_REASON_LABELS: Record<SignatureVerdictReason, string> = {
  'integrity-failed': 'signed content was altered after signing',
  'integrity-unknown': 'signed content could not be verified',
  'chain-invalid': 'certificate chain failed verification',
  'chain-not-checked': 'certificate chain could not be checked',
  'root-not-trusted': "certificate doesn't chain to a trusted root",
  'root-revoked': 'certificate chains to a revoked trust-list entry',
}

/**
 * The chain badge used to only report structural validity (each cert
 * genuinely issued by the next one up, valid at signing time) — a chain
 * anchored to an untrusted or unrecognized root could still show "valid,"
 * which doesn't match what getSignatureVerdict actually treats as passing.
 * This folds root-of-trust status into the same badge, using the identical
 * three-part check (signatures verified, valid at signing time, root
 * trusted) so this badge and the overall signature verdict never disagree.
 */
function ChainVerificationBadge({
  result,
  trustedRoot,
}: {
  result: ChainVerificationResult | null
  trustedRoot: TrustedRootCheckResult | null
}) {
  if (!result) {
    return (
      <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-xs font-medium text-yellow-400">
        Chain not checked
      </span>
    )
  }
  const structurallyValid = result.allSignaturesValid && result.allValidAtSigningTime
  const rootTrusted = trustedRoot?.status === 'trusted'
  if (structurallyValid && rootTrusted) {
    return (
      <span className="rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-400">
        Chain valid
      </span>
    )
  }
  return (
    <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-400">
      {!structurallyValid
        ? 'Chain verification failed'
        : trustedRoot?.status === 'revoked'
          ? 'Root revoked'
          : 'Root not trusted'}
    </span>
  )
}

function ChainLinkBadge({ link }: { link: CertChainLinkResult }) {
  const timeNote =
    link.wasValidAtSigningTime === false ? ' · expired at signing time' : ''

  switch (link.status) {
    case 'signature-valid':
      return (
        <span className="text-green-400">✓ issuer signature verified{timeNote}</span>
      )
    case 'signature-invalid':
      return <span className="text-red-400">✗ issuer signature INVALID{timeNote}</span>
    case 'issuer-not-found':
      return (
        <span className="text-ink-faint">
          {link.detail ?? 'root / issuer not in chain'}
          {timeNote}
        </span>
      )
    case 'unsupported-algorithm':
      return (
        <span className="text-yellow-500">
          not checked ({link.detail ?? 'unsupported algorithm'}){timeNote}
        </span>
      )
    case 'error':
      return (
        <span className="text-yellow-500">
          check failed ({link.detail ?? 'error'}){timeNote}
        </span>
      )
  }
}

function qcTypeLabel(qcType: 'esign' | 'eseal' | 'web' | null): string | null {
  switch (qcType) {
    case 'esign':
      return 'Qualified for electronic signature (natural person)'
    case 'eseal':
      return 'Qualified for electronic seal (legal entity) — not suitable for identifying a natural person under eIDAS Art. 24(1)(c)'
    case 'web':
      return 'Qualified for website authentication'
    default:
      return null
  }
}

interface ChangesSinceResult {
  visibleTextChanged: boolean
  addedSignatures: SignatureInfo[]
  hasUnidentifiedGrowth: boolean
}
