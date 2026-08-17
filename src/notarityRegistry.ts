/**
 * MOCK DATA — for demo purposes only. A real "was this document created on
 * notarity" check would query notarity's own backend by document hash; no
 * such backend exists here, so this is a hardcoded lookup table.
 *
 * Keyed by the whole-file SHA-256 hash (base64), the same one shown in the
 * "Document hash" section — so the match is exact-file, tamper-evident by
 * construction: any edit to the PDF changes its hash and the record no
 * longer matches, rather than being a cosmetic flag that could be spoofed
 * by editing unrelated fields.
 */

export interface SigningEvent {
  signerName: string
  signedAt: string // ISO 8601
}

export interface NotarizedDocumentRecord {
  documentTitle: string
  signingEvents: SigningEvent[]
  notary: {
    name: string
    jurisdiction: string
    registryName: string
  }
}

const MOCK_NOTARIZED_DOCUMENTS: Record<string, NotarizedDocumentRecord> = {
  'lm1fCdOkI9ZRmK0LerTJxsY+Y2fKjUsjbEBXxCIh1kw=': {
    documentTitle: 'Poder Notarial (notarity platform sample)',
    signingEvents: [
      { signerName: 'María Dolores Fernández Ruiz', signedAt: '2026-03-12T15:20:00Z' },
      { signerName: 'Javier Antonio Moreno García', signedAt: '2026-03-12T15:25:00Z' },
    ],
    notary: {
      name: 'Anna Lindqvist',
      jurisdiction: 'Stockholm, Sweden',
      registryName: 'Länsstyrelsen (Swedish County Administrative Board) — Notarius Publicus Register',
    },
  },
}

export function checkNotarizedOnNotarity(
  fileHashBase64: string,
): NotarizedDocumentRecord | null {
  return MOCK_NOTARIZED_DOCUMENTS[fileHashBase64] ?? null
}
