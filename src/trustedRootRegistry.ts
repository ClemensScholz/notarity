import type { CertificateInfo } from './pdfSignatures'

/**
 * MOCK DATA — for demo purposes only. A real "is this a trusted root"
 * check would consult an actual trust list (e.g. the EU's LOTL/eIDAS
 * Trusted Lists, or a browser/OS root store) by the root certificate's
 * public key or fingerprint; none is integrated here, so this is a
 * hardcoded lookup table keyed by the root/CA's Common Name, mirroring how
 * checkNotaryStatus and checkNotarizedOnNotarity mock their own registries.
 *
 * Matched against the root of each signature's certificate chain — the
 * self-signed cert at the top, or (when the chain doesn't include a
 * self-signed cert) the issuer named by the leaf's issuing CA.
 */

export type TrustListStatus = 'trusted' | 'revoked' | 'not_found'

export interface TrustedRootCheckResult {
  status: TrustListStatus
  rootName: string | null
  serviceProvider: string | null
}

interface TrustListRecord {
  serviceProvider: string
  status: TrustListStatus
}

// Mock trust list: root CA name (case-insensitive, matched against the
// chain's self-signed root CN — or, when the root itself isn't embedded in
// the chain, the name of whoever issued the top embedded cert) -> trust
// record. Keyed on the actual root, not an intermediate CA: a real PKI
// chain is leaf -> intermediate(s) -> self-signed root, and it's the root
// a trust list anchors to.
const MOCK_TRUST_LIST: Record<string, TrustListRecord> = {
  'swisscom root ca 4': {
    serviceProvider: 'Swisscom Trust Services',
    status: 'trusted',
  },
  'a-trust-root-05': {
    serviceProvider: 'A-Trust Ges. f. Sicherheitssysteme im elektr. Datenverkehr GmbH',
    status: 'trusted',
  },
  'cryptas-primesign qualified root ca': {
    serviceProvider: 'PrimeSign GmbH',
    status: 'trusted',
  },
  'fnmt persona física ca': {
    serviceProvider: 'Fábrica Nacional de Moneda y Timbre',
    status: 'trusted',
  },
  'notarius publicus qualified ca': {
    serviceProvider: 'Länsstyrelsen Sverige',
    status: 'trusted',
  },
}

function getRdnField(dn: string, field: string): string | null {
  const m = dn.match(new RegExp(`(?:^|,\\s*)${field}=([^,]+)`))
  return m ? m[1].trim() : null
}

/**
 * The root of trust for a chain: the self-signed certificate at its top if
 * one is present, otherwise the name of whoever issued the leaf (the chain
 * is incomplete, but that issuer is still the identity being trusted or
 * not). Matches how orderChainLeafToRoot walks the chain, without requiring
 * that function's ordering guarantees here.
 */
function findRootName(chain: CertificateInfo[]): string | null {
  const selfSigned = chain.find((c) => c.isSelfSigned)
  const rootDn = selfSigned?.subject ?? chain[chain.length - 1]?.issuer ?? null
  if (!rootDn) return null
  return getRdnField(rootDn, 'CN') ?? rootDn
}

/**
 * Checks whether a signature's certificate chain terminates in a root
 * that's listed in the (mocked) trust list — the same "is this cert chain
 * anchored to something we actually trust" question a real verification
 * report answers by consulting a live trust list rather than just checking
 * that the chain is cryptographically self-consistent.
 */
export function checkTrustedRoot(
  chain: CertificateInfo[],
): TrustedRootCheckResult {
  const notFound: TrustedRootCheckResult = {
    status: 'not_found',
    rootName: null,
    serviceProvider: null,
  }
  if (chain.length === 0) return notFound

  const rootName = findRootName(chain)
  if (!rootName) return notFound

  const record = MOCK_TRUST_LIST[rootName.toLowerCase()]
  if (!record) {
    return { status: 'not_found', rootName, serviceProvider: null }
  }

  return {
    status: record.status,
    rootName,
    serviceProvider: record.serviceProvider,
  }
}
