import type { CertificateInfo } from './pdfSignatures'

/**
 * MOCK DATA — for demo purposes only. A real notary check would query a
 * live, authoritative registry (e.g. a state bar, chamber of notaries, or
 * an EU member state's notary register) by the notary's official ID;
 * none is integrated here, so this is a hardcoded lookup table.
 *
 * Detection is registry-first, not keyword-based: a signer is treated as a
 * notary only if their certificate's name matches a known entry in this
 * mocked registry (optionally cross-checked by country) — not because some
 * free-text field in their certificate happens to contain a word like
 * "notary". A real certificate's Organization/OU text is self-declared by
 * whoever issued it and proves nothing on its own; the registry lookup is
 * the actual check.
 */

export type NotaryRegistryStatus = 'valid' | 'expired' | 'not_found'

export interface NotaryCheckResult {
  isNotary: boolean
  registryStatus: NotaryRegistryStatus
  jurisdiction: string | null
  registryName: string | null
}

interface NotaryRecord {
  status: NotaryRegistryStatus
  jurisdiction: string
  registryName: string
  /** ISO 3166-1 alpha-2 country code, cross-checked against the cert's C=
   * field when present, so a same-named person in a different country
   * doesn't falsely match. */
  country: string
}

// Mock registry: notary name (case-insensitive, matched against the cert
// subject CN) -> registration record.
const MOCK_NOTARY_REGISTRY: Record<string, NotaryRecord> = {
  'amelia j. harrow': {
    status: 'valid',
    jurisdiction: 'Wien, Österreich',
    registryName: 'Österreichische Notariatskammer (Austrian Chamber of Notaries)',
    country: 'AT',
  },
  'birgit hofmann': {
    status: 'expired',
    jurisdiction: 'Salzburg, Österreich',
    registryName: 'Österreichische Notariatskammer (Austrian Chamber of Notaries)',
    country: 'AT',
  },
  'anna lindqvist': {
    status: 'valid',
    jurisdiction: 'Stockholm, Sweden',
    registryName: 'Länsstyrelsen (Swedish County Administrative Board) — Notarius Publicus Register',
    country: 'SE',
  },
}

function getRdnField(dn: string, field: string): string | null {
  const m = dn.match(new RegExp(`(?:^|,\\s*)${field}=([^,]+)`))
  return m ? m[1].trim() : null
}

/**
 * Checks whether a signature's certificate belongs to someone listed in the
 * (mocked) notary registry. Matched by name (cert CN, falling back to the
 * PDF's self-reported signer name) and, when the cert states a country,
 * cross-checked against the registry record's country so a same-named
 * person elsewhere doesn't produce a false match.
 */
export function checkNotaryStatus(
  signerCert: CertificateInfo | null,
  signerName: string | null,
): NotaryCheckResult {
  const notFound: NotaryCheckResult = {
    isNotary: false,
    registryStatus: 'not_found',
    jurisdiction: null,
    registryName: null,
  }
  if (!signerCert) return notFound

  const lookupName = (
    getRdnField(signerCert.subject, 'CN') ??
    signerName ??
    ''
  ).toLowerCase()
  if (!lookupName) return notFound

  const record = MOCK_NOTARY_REGISTRY[lookupName]
  if (!record) return notFound

  const certCountry = getRdnField(signerCert.subject, 'C')
  if (certCountry && certCountry.toUpperCase() !== record.country) {
    return notFound
  }

  return {
    isNotary: true,
    registryStatus: record.status,
    jurisdiction: record.jurisdiction,
    registryName: record.registryName,
  }
}
