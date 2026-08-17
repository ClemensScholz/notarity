import forge from 'node-forge'
import { checkNotaryStatus, type NotaryCheckResult } from './notaryRegistry'
import {
  checkTrustedRoot,
  type TrustedRootCheckResult,
} from './trustedRootRegistry'

export interface QualifiedCertStatements {
  isQualified: boolean
  qcType: 'esign' | 'eseal' | 'web' | null
  isQscd: boolean
  pdsUrls: string[]
}

export interface CertificateInfo {
  subject: string
  issuer: string
  serialNumber: string
  validFrom: string
  validTo: string
  isSelfSigned: boolean
  keyUsages: string[]
  certificatePolicyUrls: string[]
  qualifiedStatements: QualifiedCertStatements | null
  /** Internal fields needed for chain verification; not meant for display. */
  _tbsDer: string
  _signatureAlgorithmOid: string | null
  /** RSASSA-PSS hash OID, when the signature algorithm is PSS (its digest
   * isn't derivable from the OID alone — PSS uses one OID for all hashes). */
  _pssHashOid: string | null
  _signatureBytes: string
  _spkiDer: string
}

export type CertLinkStatus =
  | 'signature-valid' // this cert's signature was verified against its issuer's public key
  | 'signature-invalid' // verified, and it FAILED
  | 'issuer-not-found' // no cert in this chain matches the issuer name (chain incomplete, or this is the root)
  | 'unsupported-algorithm' // we don't know how to verify this key/signature combo
  | 'error' // verification threw

export interface CertChainLinkResult {
  certIndex: number
  status: CertLinkStatus
  wasValidAtSigningTime: boolean | null
  detail: string | null
}

export interface ChainVerificationResult {
  links: CertChainLinkResult[]
  allSignaturesValid: boolean
  allValidAtSigningTime: boolean
}

export interface SignatureInfo {
  index: number
  signerName: string | null
  signingTime: string | null
  reason: string | null
  location: string | null
  contactInfo: string | null
  subFilter: string | null
  signatureLevel: string
  signatureType: string
  signatureAlgorithmName: string | null
  isTimestamp: boolean
  timestampFor: number | null
  byteRange: [number, number, number, number] | null
  coversWholeFile: boolean
  integrityValid: boolean | null
  integrityError: string | null
  certificateChain: CertificateInfo[]
  chainVerification: ChainVerificationResult | null
  notary: NotaryCheckResult | null
  trustedRoot: TrustedRootCheckResult | null
  raw: {
    fieldName: string | null
  }
}

/** Finds the byte offsets of every `/Type /Sig` or `/Type /DocTimeStamp` dictionary in the raw PDF and pulls out its key/value pairs by scanning balanced dict braces — a lightweight substitute for a full PDF object parser. */
function findSignatureDictionaries(bytes: Uint8Array): string[] {
  const latin1 = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('')

  const dictStrings: string[] = []
  const typeRegex = /\/Type\s*\/(Sig|DocTimeStamp)\b/g
  let match: RegExpExecArray | null

  while ((match = typeRegex.exec(latin1))) {
    // Walk backwards to the nearest unmatched "<<" that opens this dict.
    let start = match.index
    let depth = 0
    while (start > 0) {
      if (latin1.startsWith('>>', start)) depth++
      else if (latin1.startsWith('<<', start)) {
        if (depth === 0) break
        depth--
      }
      start--
    }
    // Walk forward from `start` tracking << >> depth to find the matching close.
    let end = start
    let d = 0
    while (end < latin1.length) {
      if (latin1.startsWith('<<', end)) {
        d++
        end += 2
        continue
      }
      if (latin1.startsWith('>>', end)) {
        d--
        end += 2
        if (d === 0) break
        continue
      }
      end++
    }
    dictStrings.push(latin1.slice(start, end))
  }

  return dictStrings
}

function extractName(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}\\s*/([^\\s/>\\]\\[]+)`)
  const m = dict.match(re)
  return m ? decodePdfName(m[1]) : null
}

function decodePdfName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

function extractPdfString(dict: string, key: string): string | null {
  // Handles literal strings ( ... ) with escapes, and hex strings < ... >.
  const litRe = new RegExp(`/${key}\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)`)
  const litMatch = dict.match(litRe)
  if (litMatch) return decodeLiteralString(litMatch[1])

  const hexRe = new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]+)>`)
  const hexMatch = dict.match(hexRe)
  if (hexMatch) return decodeHexString(hexMatch[1])

  return null
}

function decodeLiteralString(s: string): string {
  let out = s.replace(/\\([nrtbf()\\])/g, (_, c) => {
    switch (c) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      default:
        return c
    }
  })
  // Literal strings may be UTF-16BE with a BOM (common for signer names).
  if (out.startsWith('\xfe\xff')) {
    const bytes = Array.from(out).map((c) => c.charCodeAt(0))
    let decoded = ''
    for (let i = 2; i < bytes.length; i += 2) {
      decoded += String.fromCharCode((bytes[i] << 8) | (bytes[i + 1] ?? 0))
    }
    return decoded
  }
  return out
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let decoded = ''
    for (let i = 2; i < bytes.length; i += 2) {
      decoded += String.fromCharCode((bytes[i] << 8) | (bytes[i + 1] ?? 0))
    }
    return decoded
  }
  return bytes.map((b) => String.fromCharCode(b)).join('')
}

function extractByteRange(
  dict: string,
): [number, number, number, number] | null {
  const m = dict.match(
    /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/,
  )
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

function extractContentsHex(dict: string): string | null {
  const m = dict.match(/\/Contents\s*<([0-9A-Fa-f\s]+)>/)
  return m ? m[1].replace(/\s+/g, '') : null
}

const SUBFILTER_LABELS: Record<string, string> = {
  'adbe.pkcs7.detached': 'PKCS#7 detached (basic)',
  'adbe.pkcs7.sha1': 'PKCS#7 SHA-1',
  'adbe.x509.rsa_sha1': 'X.509 + RSA/SHA-1 (legacy)',
  'etsi.cades.detached': 'CAdES (PAdES-compatible, advanced)',
  'etsi.rfc3161': 'RFC 3161 timestamp',
}

function describeSignatureLevel(subFilter: string | null): string {
  if (!subFilter) return 'Unknown'
  return SUBFILTER_LABELS[subFilter.toLowerCase()] ?? subFilter
}

// The SubFilter also identifies which signature standard/family produced
// it — CMS (plain PKCS#7), CAdES (ETSI's PAdES-compatible CMS profile), or
// an RFC 3161 timestamp token — a coarser, more report-familiar grouping
// than the full "signature level" description above.
const SIGNATURE_TYPE_BY_SUBFILTER: Record<string, string> = {
  'adbe.pkcs7.detached': 'CMS (PKCS#7)',
  'adbe.pkcs7.sha1': 'CMS (PKCS#7)',
  'adbe.x509.rsa_sha1': 'X.509/RSA (legacy)',
  'etsi.cades.detached': 'CAdES',
  'etsi.rfc3161': 'RFC 3161 Timestamp',
}

function describeSignatureType(
  subFilter: string | null,
  isTimestamp: boolean,
): string {
  if (isTimestamp) return 'RFC 3161 Timestamp'
  if (!subFilter) return 'Unknown'
  return SIGNATURE_TYPE_BY_SUBFILTER[subFilter.toLowerCase()] ?? subFilter
}

// signatureAlgorithm OID -> human label, matching how verification reports
// commonly describe it (digest name + key algorithm, e.g. "SHA256withECDSA").
const SIGNATURE_ALGORITHM_LABELS: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'SHA1withRSA',
  '1.2.840.113549.1.1.11': 'SHA256withRSA',
  '1.2.840.113549.1.1.12': 'SHA384withRSA',
  '1.2.840.113549.1.1.13': 'SHA512withRSA',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS', // exact digest requires reading params; refined below
  '1.2.840.10045.4.1': 'SHA1withECDSA',
  '1.2.840.10045.4.3.2': 'SHA256withECDSA',
  '1.2.840.10045.4.3.3': 'SHA384withECDSA',
  '1.2.840.10045.4.3.4': 'SHA512withECDSA',
}

function describeSignatureAlgorithm(
  sigAlgOid: string | null,
  digestAlgOid: string | null,
): string | null {
  if (!sigAlgOid) return null
  const label = SIGNATURE_ALGORITHM_LABELS[sigAlgOid]
  if (sigAlgOid === '1.2.840.113549.1.1.10') {
    // RSASSA-PSS carries the actual digest alg in its params, but we already
    // parsed the SignerInfo's own digestAlgorithm field, which matches.
    const digestName =
      digestAlgOid === forge.pki.oids.sha256
        ? 'SHA256'
        : digestAlgOid === forge.pki.oids.sha384
          ? 'SHA384'
          : digestAlgOid === forge.pki.oids.sha512
            ? 'SHA512'
            : digestAlgOid === forge.pki.oids.sha1
              ? 'SHA1'
              : null
    return digestName ? `${digestName}withRSAandMGF1` : label
  }
  return label ?? sigAlgOid
}

function forgeDateToIso(d: Date | undefined): string | null {
  if (!d) return null
  return d.toISOString()
}

function rdnToString(rdn: forge.pki.RdnAttribute[]): string {
  return rdn
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .join(', ')
}

// RFC 3739 / ETSI EN 319 412-5 QC statement OIDs.
const OID_QC_STATEMENTS = '1.3.6.1.5.5.7.1.3'
const OID_QC_COMPLIANCE = '0.4.0.1862.1.1'
const OID_QC_TYPE = '0.4.0.1862.1.6'
const OID_QC_PDS = '0.4.0.1862.1.5'
const OID_QC_SSCD = '1.3.6.1.5.5.7.11.2' // aka QCStatement id-etsi-qcs-QcSSCD
const OID_QC_TYPE_ESIGN = '0.4.0.1862.1.6.1'
const OID_QC_TYPE_ESEAL = '0.4.0.1862.1.6.2'
const OID_QC_TYPE_WEB = '0.4.0.1862.1.6.3'

function parseQcStatements(der: string): QualifiedCertStatements {
  const result: QualifiedCertStatements = {
    isQualified: false,
    qcType: null,
    isQscd: false,
    pdsUrls: [],
  }
  try {
    const seq = forge.asn1.fromDer(der, { parseAllBytes: false })
    for (const stmt of seq.value as forge.asn1.Asn1[]) {
      if (!Array.isArray(stmt.value) || stmt.value.length === 0) continue
      const oid = forge.asn1.derToOid(
        (stmt.value[0] as forge.asn1.Asn1).value as string,
      )
      if (oid === OID_QC_COMPLIANCE) {
        result.isQualified = true
      } else if (oid === OID_QC_SSCD) {
        result.isQscd = true
      } else if (oid === OID_QC_TYPE) {
        const typeSeq = stmt.value[1] as forge.asn1.Asn1 | undefined
        const typeOidNode = typeSeq?.value?.[0] as forge.asn1.Asn1 | undefined
        const typeOid = typeOidNode
          ? forge.asn1.derToOid(typeOidNode.value as string)
          : null
        result.qcType =
          typeOid === OID_QC_TYPE_ESIGN
            ? 'esign'
            : typeOid === OID_QC_TYPE_ESEAL
              ? 'eseal'
              : typeOid === OID_QC_TYPE_WEB
                ? 'web'
                : null
      } else if (oid === OID_QC_PDS) {
        const pdsSeq = stmt.value[1] as forge.asn1.Asn1 | undefined
        for (const entry of (pdsSeq?.value ?? []) as forge.asn1.Asn1[]) {
          const urlNode = entry.value?.[0] as forge.asn1.Asn1 | undefined
          if (urlNode && typeof urlNode.value === 'string') {
            result.pdsUrls.push(urlNode.value)
          }
        }
      }
    }
  } catch {
    // malformed/unsupported QCStatements — leave defaults
  }
  return result
}

/**
 * Parses a TBSCertificate's fields directly from ASN.1 instead of using
 * forge's `pki.certificateFromAsn1`, which throws on any non-RSA public key
 * ("Cannot read public key. OID is not RSA."). ECDSA-signed certificates are
 * common among qualified trust providers, and none of the fields we display
 * (subject, issuer, validity, extensions) require decoding the public key.
 * TBSCertificate ::= SEQUENCE { [0] version, serialNumber, signature,
 *   issuer, validity, subject, subjectPublicKeyInfo, [3] extensions }
 */
function certToInfo(certAsn1: forge.asn1.Asn1): CertificateInfo {
  const tbs = certAsn1.value[0] as forge.asn1.Asn1

  const serialBytes = (tbs.value[1] as forge.asn1.Asn1).value as string
  const serialNumber = forge.util.bytesToHex(serialBytes).replace(/^0+(?=.)/, '')

  const issuerAttrs = forge.pki.RDNAttributesAsArray(
    tbs.value[3] as forge.asn1.Asn1,
  )
  const subjectAttrs = forge.pki.RDNAttributesAsArray(
    tbs.value[5] as forge.asn1.Asn1,
  )
  const issuer = rdnToString(issuerAttrs)
  const subject = rdnToString(subjectAttrs)

  const validityNode = tbs.value[4] as forge.asn1.Asn1
  const timeToDate = (node: forge.asn1.Asn1) =>
    node.type === forge.asn1.Type.UTCTIME
      ? forge.asn1.utcTimeToDate(node.value as string)
      : forge.asn1.generalizedTimeToDate(node.value as string)
  const validFrom = timeToDate(validityNode.value[0] as forge.asn1.Asn1)
  const validTo = timeToDate(validityNode.value[1] as forge.asn1.Asn1)

  const keyUsages: string[] = []
  const certificatePolicyUrls: string[] = []
  let qualifiedStatements: QualifiedCertStatements | null = null

  // extensions are [3] EXPLICIT SEQUENCE OF Extension; not all certs have them.
  const extWrapper = tbs.value[7] as forge.asn1.Asn1 | undefined
  if (extWrapper?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC) {
    const extsSeq = extWrapper.value[0] as forge.asn1.Asn1
    for (const extAsn1 of extsSeq.value as forge.asn1.Asn1[]) {
      let ext: forge.pki.CertificateExtension
      try {
        ext = forge.pki.certificateExtensionFromAsn1(extAsn1)
      } catch {
        continue
      }
      if (ext.name === 'keyUsage') {
        const anyExt = ext as unknown as Record<string, boolean>
        const flags = [
          'digitalSignature',
          'nonRepudiation',
          'keyEncipherment',
          'dataEncipherment',
          'keyAgreement',
          'keyCertSign',
          'cRLSign',
          'encipherOnly',
          'decipherOnly',
        ]
        keyUsages.push(...flags.filter((f) => anyExt[f]))
      } else if (ext.name === 'certificatePolicies') {
        const policiesAsn1 = forge.asn1.fromDer(ext.value, {
          parseAllBytes: false,
        })
        for (const policy of policiesAsn1.value as forge.asn1.Asn1[]) {
          const qualifiers = (policy.value?.[1] as forge.asn1.Asn1 | undefined)
            ?.value as forge.asn1.Asn1[] | undefined
          for (const qualifier of qualifiers ?? []) {
            const cpsUri = qualifier.value?.[1] as forge.asn1.Asn1 | undefined
            if (cpsUri && typeof cpsUri.value === 'string') {
              certificatePolicyUrls.push(cpsUri.value)
            }
          }
        }
      } else if (ext.id === OID_QC_STATEMENTS) {
        qualifiedStatements = parseQcStatements(ext.value)
      }
    }
  }

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  // Re-encoding tbs to DER gives back the exact bytes the issuer signed over.
  const tbsDer = forge.asn1.toDer(tbs).getBytes()
  const certSignatureAlgorithmNode = certAsn1.value[1] as forge.asn1.Asn1
  const signatureAlgorithmOid = certSignatureAlgorithmNode?.value?.[0]
    ? forge.asn1.derToOid(
        (certSignatureAlgorithmNode.value[0] as forge.asn1.Asn1).value as string,
      )
    : null
  // RSASSA-PSS ::= SEQUENCE { [0] hashAlgorithm, [1] maskGenAlgorithm, [2] saltLength }
  // its own OID never varies by digest, so the hash lives in these params.
  let pssHashOid: string | null = null
  if (signatureAlgorithmOid === OID_RSASSA_PSS) {
    const paramsSeq = certSignatureAlgorithmNode.value[1] as
      | forge.asn1.Asn1
      | undefined
    const hashAlgWrapper = paramsSeq?.value?.[0] as forge.asn1.Asn1 | undefined
    const hashAlgSeq = hashAlgWrapper?.value?.[0] as forge.asn1.Asn1 | undefined
    if (hashAlgSeq) {
      pssHashOid = forge.asn1.derToOid(
        (hashAlgSeq.value[0] as forge.asn1.Asn1).value as string,
      )
    }
  }
  // signatureValue is a BIT STRING; forge stores it as [unusedBitsByte, ...bytes].
  const signatureBitString = (certAsn1.value[2] as forge.asn1.Asn1)
    .value as string
  const signatureBytes = signatureBitString.slice(1)
  const spkiNode = tbs.value[6] as forge.asn1.Asn1
  const spkiDer = forge.asn1.toDer(spkiNode).getBytes()

  return {
    subject,
    issuer,
    serialNumber,
    validFrom: forgeDateToIso(validFrom) ?? '',
    validTo: forgeDateToIso(validTo) ?? '',
    isSelfSigned: subject === issuer,
    keyUsages,
    certificatePolicyUrls,
    qualifiedStatements,
    _tbsDer: tbsDer,
    _signatureAlgorithmOid: signatureAlgorithmOid,
    _pssHashOid: pssHashOid,
    _signatureBytes: signatureBytes,
    _spkiDer: spkiDer,
  }
}

/**
 * SignedData ::= SEQUENCE { version, digestAlgorithms SET, contentInfo,
 *   [0] IMPLICIT certificates SET OPTIONAL, [1] crls OPTIONAL, signerInfos }
 * Extracted manually (rather than via `pkcs7.messageFromAsn1`) so the same
 * code path works for both ordinary signatures and RFC 3161 timestamp
 * tokens, which forge's high-level parser rejects.
 */
/**
 * PDFs don't guarantee certificates are embedded in any particular order
 * (we've seen leaf, root, intermediate in that literal order). Re-sort them
 * leaf -> ... -> root, matching how a person reads a chain: "who signed
 * this" first, then who vouches for them, up to the ultimate root.
 * The leaf is whichever cert nothing else in the chain lists as its issuer;
 * from there, walk each cert's own `issuer` field to the next one up.
 */
function orderChainLeafToRoot(chain: CertificateInfo[]): CertificateInfo[] {
  if (chain.length <= 1) return chain

  const issuedByAny = new Set(chain.map((c) => c.issuer))
  const leaf = chain.find((c) => !issuedByAny.has(c.subject)) ?? chain[0]

  const ordered: CertificateInfo[] = []
  const remaining = new Set(chain)
  let current: CertificateInfo | undefined = leaf

  while (current && remaining.has(current)) {
    ordered.push(current)
    remaining.delete(current)
    if (current.isSelfSigned) break
    current = chain.find((c) => remaining.has(c) && c.subject === current!.issuer)
  }

  // Anything left over (shouldn't normally happen) is appended as-is rather
  // than silently dropped.
  return [...ordered, ...remaining]
}

function extractCertificates(signedDataAsn1: forge.asn1.Asn1): CertificateInfo[] {
  const certsNode = (signedDataAsn1.value as forge.asn1.Asn1[]).find(
    (v): v is forge.asn1.Asn1 =>
      typeof v === 'object' &&
      'tagClass' in v &&
      v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
      v.type === 0,
  )
  if (!certsNode || !Array.isArray(certsNode.value)) return []

  const certs: CertificateInfo[] = []
  for (const certAsn1 of certsNode.value as forge.asn1.Asn1[]) {
    try {
      certs.push(certToInfo(certAsn1))
    } catch {
      // skip anything that isn't a parseable X.509 certificate
    }
  }
  return certs
}

function binaryStringToArrayBuffer(bin: string): ArrayBuffer {
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i) & 0xff
  return buf.buffer
}

const EC_CURVE_BY_OID: Record<string, { namedCurve: string; byteLength: number }> = {
  '1.2.840.10045.3.1.7': { namedCurve: 'P-256', byteLength: 32 },
  '1.3.132.0.34': { namedCurve: 'P-384', byteLength: 48 },
  '1.3.132.0.35': { namedCurve: 'P-521', byteLength: 66 },
}

const RSA_SIG_ALG_DIGEST: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'SHA-1',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
}

const OID_RSASSA_PSS = '1.2.840.113549.1.1.10'
// PSS hash OID -> { Web Crypto hash name, digest output length in bytes,
// used as the (default) salt length per RFC 8017 when params omit one }.
const PSS_HASH_INFO: Record<string, { hash: string; saltLength: number }> = {
  '1.3.14.3.2.26': { hash: 'SHA-1', saltLength: 20 },
  '2.16.840.1.101.3.4.2.1': { hash: 'SHA-256', saltLength: 32 },
  '2.16.840.1.101.3.4.2.2': { hash: 'SHA-384', saltLength: 48 },
  '2.16.840.1.101.3.4.2.3': { hash: 'SHA-512', saltLength: 64 },
}

const ECDSA_SIG_ALG_DIGEST: Record<string, string> = {
  '1.2.840.10045.4.1': 'SHA-1',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
}

/** Converts a DER-encoded ECDSA SEQUENCE{r,s} signature into the fixed-width
 * raw r||s format Web Crypto's ECDSA verify expects. */
function ecdsaDerToRaw(der: string, byteLength: number): ArrayBuffer {
  const seq = forge.asn1.fromDer(der, { parseAllBytes: false })
  const r = (seq.value[0] as forge.asn1.Asn1).value as string
  const s = (seq.value[1] as forge.asn1.Asn1).value as string
  const pad = (v: string) => {
    const trimmed = v.replace(/^\x00+(?=.)/, '')
    if (trimmed.length > byteLength) {
      throw new Error('EC signature integer longer than curve order.')
    }
    return '\x00'.repeat(byteLength - trimmed.length) + trimmed
  }
  const raw = pad(r) + pad(s)
  return binaryStringToArrayBuffer(raw)
}

/**
 * Verifies that `child` was actually signed by `issuer`'s key, i.e. that
 * issuer.publicKey correctly validates the signature over child's
 * TBSCertificate bytes. This proves an unbroken cryptographic chain of
 * custody — it does NOT prove `issuer` is a trustworthy root (that would
 * require comparing against a bundled/live trusted-root list, which this
 * app deliberately does not do — see chainVerification docs).
 */
async function verifyCertSignedByIssuer(
  child: CertificateInfo,
  issuer: CertificateInfo,
): Promise<{ status: CertLinkStatus; detail: string | null }> {
  const sigAlgOid = child._signatureAlgorithmOid
  if (!sigAlgOid) {
    return { status: 'unsupported-algorithm', detail: 'No signature algorithm found.' }
  }

  try {
    if (sigAlgOid in RSA_SIG_ALG_DIGEST) {
      const hash = RSA_SIG_ALG_DIGEST[sigAlgOid]
      const key = await crypto.subtle.importKey(
        'spki',
        binaryStringToArrayBuffer(issuer._spkiDer),
        { name: 'RSASSA-PKCS1-v1_5', hash },
        false,
        ['verify'],
      )
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        binaryStringToArrayBuffer(child._signatureBytes),
        binaryStringToArrayBuffer(child._tbsDer),
      )
      return {
        status: valid ? 'signature-valid' : 'signature-invalid',
        detail: null,
      }
    }

    if (sigAlgOid === OID_RSASSA_PSS) {
      const pssInfo = child._pssHashOid
        ? PSS_HASH_INFO[child._pssHashOid]
        : undefined
      if (!pssInfo) {
        return {
          status: 'unsupported-algorithm',
          detail: `Unsupported RSASSA-PSS hash (${child._pssHashOid ?? 'unknown'}).`,
        }
      }
      const key = await crypto.subtle.importKey(
        'spki',
        binaryStringToArrayBuffer(issuer._spkiDer),
        { name: 'RSA-PSS', hash: pssInfo.hash },
        false,
        ['verify'],
      )
      const valid = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: pssInfo.saltLength },
        key,
        binaryStringToArrayBuffer(child._signatureBytes),
        binaryStringToArrayBuffer(child._tbsDer),
      )
      return {
        status: valid ? 'signature-valid' : 'signature-invalid',
        detail: null,
      }
    }

    if (sigAlgOid in ECDSA_SIG_ALG_DIGEST) {
      const hash = ECDSA_SIG_ALG_DIGEST[sigAlgOid]
      // Determine the issuer's curve from its own SPKI algorithm params.
      const spkiAsn1 = forge.asn1.fromDer(issuer._spkiDer, {
        parseAllBytes: false,
      })
      const algSeq = spkiAsn1.value[0] as forge.asn1.Asn1
      const curveOid = forge.asn1.derToOid(
        (algSeq.value[1] as forge.asn1.Asn1).value as string,
      )
      const curve = EC_CURVE_BY_OID[curveOid]
      if (!curve) {
        return {
          status: 'unsupported-algorithm',
          detail: `Unsupported EC curve (${curveOid}).`,
        }
      }
      const key = await crypto.subtle.importKey(
        'spki',
        binaryStringToArrayBuffer(issuer._spkiDer),
        { name: 'ECDSA', namedCurve: curve.namedCurve },
        false,
        ['verify'],
      )
      const rawSig = ecdsaDerToRaw(child._signatureBytes, curve.byteLength)
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash },
        key,
        rawSig,
        binaryStringToArrayBuffer(child._tbsDer),
      )
      return {
        status: valid ? 'signature-valid' : 'signature-invalid',
        detail: null,
      }
    }

    return {
      status: 'unsupported-algorithm',
      detail: `Unsupported signature algorithm (${sigAlgOid}).`,
    }
  } catch (err) {
    return {
      status: 'error',
      detail: err instanceof Error ? err.message : 'Verification failed.',
    }
  }
}

/**
 * Checks each certificate in the chain against its issuer (matched by
 * subject/issuer name within the chain, not array order — PDFs don't
 * guarantee the certs are listed in any particular order). For each cert:
 *  1. Cryptographically verify its signature against the issuer's public key.
 *  2. Confirm the signing time falls within its [validFrom, validTo] window.
 * A self-signed root has no issuer within the chain to check against, so it
 * is reported as 'issuer-not-found' — expected and not an error by itself.
 */
export async function verifyCertificateChain(
  chain: CertificateInfo[],
  signingTimeIso: string | null,
): Promise<ChainVerificationResult> {
  const signingTime = signingTimeIso ? new Date(signingTimeIso) : null
  const links: CertChainLinkResult[] = []

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]
    const wasValidAtSigningTime = signingTime
      ? signingTime >= new Date(cert.validFrom) &&
        signingTime <= new Date(cert.validTo)
      : null

    if (cert.isSelfSigned) {
      links.push({
        certIndex: i,
        status: 'issuer-not-found',
        wasValidAtSigningTime,
        detail: null,
      })
      continue
    }

    const issuerCert = chain.find((c) => c.subject === cert.issuer)
    if (!issuerCert) {
      links.push({
        certIndex: i,
        status: 'issuer-not-found',
        wasValidAtSigningTime,
        detail: 'Issuer certificate not included in this chain.',
      })
      continue
    }

    const { status, detail } = await verifyCertSignedByIssuer(cert, issuerCert)
    links.push({ certIndex: i, status, wasValidAtSigningTime, detail })
  }

  const allSignaturesValid = links.every(
    (l) => l.status === 'signature-valid' || l.status === 'issuer-not-found',
  )
  const allValidAtSigningTime = links.every(
    (l) => l.wasValidAtSigningTime !== false,
  )

  return { links, allSignaturesValid, allValidAtSigningTime }
}

const ATTR_OID_MESSAGE_DIGEST = forge.pki.oids.messageDigest
const ATTR_OID_SIGNING_TIME = forge.pki.oids.signingTime
// id-aa-signatureTimeStampToken (RFC 3161 / CAdES-T): an unauthenticated
// attribute carrying a full RFC 3161 timestamp token — itself a CMS
// SignedData wrapping a TSTInfo — issued by a trusted timestamp authority
// over the signature value. Its TSTInfo.genTime is a third-party-attested
// time, unlike `/M` or the authenticated `signingTime` attribute, both of
// which are just the signer's own local-clock claim.
const OID_SIGNATURE_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14'

interface ParsedSignerInfo {
  digestAlgorithmOid: string | null
  signatureAlgorithmOid: string | null
  messageDigestHex: string | null
  signingTime: string | null
  tsaTimestamp: string | null
}

/** Extracts TSTInfo.genTime from an RFC 3161 timestamp token's DER bytes.
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber,
 * genTime, ... } — the token itself is ContentInfo -> SignedData ->
 * encapContentInfo.eContent, which holds the TSTInfo DER. */
function extractTsaGenTime(tsTokenContentInfo: forge.asn1.Asn1): string | null {
  try {
    const explicitWrapper = tsTokenContentInfo.value[1] as forge.asn1.Asn1
    const tsSignedData = explicitWrapper.value[0] as forge.asn1.Asn1
    const encapContentInfo = tsSignedData.value[2] as forge.asn1.Asn1
    const eContentWrapper = encapContentInfo.value[1] as forge.asn1.Asn1 | undefined
    const octet = eContentWrapper?.value?.[0] as forge.asn1.Asn1 | undefined
    if (!octet || typeof octet.value !== 'string') return null

    const tstInfoAsn1 = forge.asn1.fromDer(octet.value, { parseAllBytes: false })
    const genTimeNode = tstInfoAsn1.value[4] as forge.asn1.Asn1 | undefined
    if (!genTimeNode || typeof genTimeNode.value !== 'string') return null

    const date =
      genTimeNode.type === forge.asn1.Type.GENERALIZEDTIME
        ? forge.asn1.generalizedTimeToDate(genTimeNode.value)
        : forge.asn1.utcTimeToDate(genTimeNode.value)
    return date.toISOString()
  } catch {
    return null
  }
}

/**
 * node-forge's high-level `pkcs7.messageFromAsn1` never actually populates
 * signerInfo.authenticatedAttributes (see its source: "TODO: convert
 * attributes"), so signature verification has to walk the raw ASN.1 tree
 * itself. Layout per RFC 2315 SignerInfo: [0]=version,
 * [1]=issuerAndSerialNumber, [2]=digestAlgorithm,
 * [3]=[0] IMPLICIT authenticatedAttributes SET, [4]=digestEncryptionAlgorithm,
 * [5]=encryptedDigest, [6]=[1] IMPLICIT unauthenticatedAttributes.
 */
function parseFirstSignerInfo(signedDataAsn1: forge.asn1.Asn1): ParsedSignerInfo | null {
  // SignedData ::= SEQUENCE { version, digestAlgorithms SET, contentInfo,
  //   [0] certificates OPTIONAL, [1] crls OPTIONAL, signerInfos SET }
  // Both digestAlgorithms and signerInfos are UNIVERSAL SETs, so take the
  // *last* one in the sequence — signerInfos always comes last.
  const universalSets = (signedDataAsn1.value as forge.asn1.Asn1[]).filter(
    (v): v is forge.asn1.Asn1 =>
      typeof v === 'object' &&
      'type' in v &&
      v.type === forge.asn1.Type.SET &&
      v.tagClass === forge.asn1.Class.UNIVERSAL,
  )
  const signerInfosSet = universalSets[universalSets.length - 1]
  const signerInfo = signerInfosSet?.value?.[0] as forge.asn1.Asn1 | undefined
  if (!signerInfo || !Array.isArray(signerInfo.value)) return null

  const digestAlgorithmNode = signerInfo.value[2] as forge.asn1.Asn1 | undefined
  const digestAlgorithmOid = digestAlgorithmNode?.value?.[0]
    ? forge.asn1.derToOid((digestAlgorithmNode.value[0] as forge.asn1.Asn1).value as string)
    : null

  const signatureAlgorithmNode = signerInfo.value[4] as forge.asn1.Asn1 | undefined
  const signatureAlgorithmOid = signatureAlgorithmNode?.value?.[0]
    ? forge.asn1.derToOid(
        (signatureAlgorithmNode.value[0] as forge.asn1.Asn1).value as string,
      )
    : null

  const authAttrsNode = signerInfo.value[3] as forge.asn1.Asn1 | undefined
  let messageDigestHex: string | null = null
  let signingTime: string | null = null

  if (
    authAttrsNode &&
    authAttrsNode.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
    Array.isArray(authAttrsNode.value)
  ) {
    for (const attr of authAttrsNode.value as forge.asn1.Asn1[]) {
      if (!Array.isArray(attr.value) || attr.value.length < 2) continue
      const oidNode = attr.value[0] as forge.asn1.Asn1
      const valueSet = attr.value[1] as forge.asn1.Asn1
      const oid = forge.asn1.derToOid(oidNode.value as string)

      if (oid === ATTR_OID_MESSAGE_DIGEST) {
        const octet = valueSet.value?.[0] as forge.asn1.Asn1 | undefined
        if (octet && typeof octet.value === 'string') {
          messageDigestHex = forge.util.bytesToHex(octet.value)
        }
      } else if (oid === ATTR_OID_SIGNING_TIME) {
        const timeNode = valueSet.value?.[0] as forge.asn1.Asn1 | undefined
        if (timeNode && typeof timeNode.value === 'string') {
          try {
            const date =
              timeNode.type === forge.asn1.Type.UTCTIME
                ? forge.asn1.utcTimeToDate(timeNode.value)
                : forge.asn1.generalizedTimeToDate(timeNode.value)
            signingTime = date.toISOString()
          } catch {
            // ignore malformed signing-time attribute
          }
        }
      }
    }
  }

  let tsaTimestamp: string | null = null
  const unauthAttrsNode = signerInfo.value[6] as forge.asn1.Asn1 | undefined
  if (
    unauthAttrsNode &&
    unauthAttrsNode.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
    Array.isArray(unauthAttrsNode.value)
  ) {
    for (const attr of unauthAttrsNode.value as forge.asn1.Asn1[]) {
      if (!Array.isArray(attr.value) || attr.value.length < 2) continue
      const oidNode = attr.value[0] as forge.asn1.Asn1
      const oid = forge.asn1.derToOid(oidNode.value as string)
      if (oid === OID_SIGNATURE_TIMESTAMP_TOKEN) {
        const valueSet = attr.value[1] as forge.asn1.Asn1
        const tsTokenContentInfo = valueSet.value?.[0] as forge.asn1.Asn1 | undefined
        if (tsTokenContentInfo) {
          tsaTimestamp = extractTsaGenTime(tsTokenContentInfo)
        }
        break
      }
    }
  }

  return {
    digestAlgorithmOid,
    signatureAlgorithmOid,
    messageDigestHex,
    signingTime,
    tsaTimestamp,
  }
}

function digestForOid(oid: string | null): forge.md.MessageDigest {
  switch (oid) {
    case forge.pki.oids.sha256:
      return forge.md.sha256.create()
    case forge.pki.oids.sha384:
      return forge.md.sha384.create()
    case forge.pki.oids.sha512:
      return forge.md.sha512.create()
    default:
      return forge.md.sha1.create()
  }
}

function verifyByteRangeIntegrity(
  fileBytes: Uint8Array,
  byteRange: [number, number, number, number],
  signerInfo: ParsedSignerInfo,
): { valid: boolean | null; error: string | null } {
  if (!signerInfo.messageDigestHex) {
    return { valid: null, error: 'Could not locate signed message digest.' }
  }

  try {
    const [s1, l1, s2, l2] = byteRange
    const part1 = fileBytes.subarray(s1, s1 + l1)
    const part2 = fileBytes.subarray(s2, s2 + l2)
    const signedContent = new Uint8Array(part1.length + part2.length)
    signedContent.set(part1, 0)
    signedContent.set(part2, part1.length)

    const binaryStr = Array.from(signedContent)
      .map((b) => String.fromCharCode(b))
      .join('')

    const md = digestForOid(signerInfo.digestAlgorithmOid)
    md.update(binaryStr)
    const computedDigest = md.digest().toHex()

    return { valid: computedDigest === signerInfo.messageDigestHex, error: null }
  } catch (err) {
    return {
      valid: null,
      error: err instanceof Error ? err.message : 'Integrity check failed.',
    }
  }
}

export async function extractPdfSignatures(
  fileBytes: Uint8Array,
): Promise<SignatureInfo[]> {
  const dicts = findSignatureDictionaries(fileBytes)
  const results: SignatureInfo[] = []

  for (let index = 0; index < dicts.length; index++) {
    const dict = dicts[index]
    const subFilter = extractName(dict, 'SubFilter')
    const isTimestamp = /\/Type\s*\/DocTimeStamp\b/.test(dict)
    const byteRange = extractByteRange(dict)
    const contentsHex = extractContentsHex(dict)

    const info: SignatureInfo = {
      index,
      signerName: extractPdfString(dict, 'Name'),
      signingTime: parsePdfDate(extractPdfString(dict, 'M')),
      reason: extractPdfString(dict, 'Reason'),
      location: extractPdfString(dict, 'Location'),
      contactInfo: extractPdfString(dict, 'ContactInfo'),
      subFilter,
      signatureLevel: describeSignatureLevel(subFilter),
      signatureType: describeSignatureType(subFilter, isTimestamp),
      signatureAlgorithmName: null,
      isTimestamp,
      timestampFor: null,
      byteRange,
      coversWholeFile:
        byteRange !== null &&
        byteRange[0] === 0 &&
        byteRange[2] + byteRange[3] >= fileBytes.length,
      integrityValid: null,
      integrityError: null,
      certificateChain: [],
      chainVerification: null,
      notary: null,
      trustedRoot: null,
      raw: { fieldName: null },
    }

    if (contentsHex) {
      try {
        const der = hexToBinaryString(contentsHex)
        // `/Contents` is a fixed-size hex placeholder reserved before signing,
        // so real DER is usually followed by trailing zero-byte padding —
        // parseAllBytes:false lets forge stop once the outer element closes.
        const contentInfoAsn1 = forge.asn1.fromDer(der, {
          parseAllBytes: false,
        })
        const contentTypeOid = forge.asn1.derToOid(
          (contentInfoAsn1.value[0] as forge.asn1.Asn1).value as string,
        )

        if (contentTypeOid !== forge.pki.oids.signedData) {
          throw new Error(`Unsupported CMS content type: ${contentTypeOid}`)
        }

        // ContentInfo.content is [0] EXPLICIT, so unwrap one more SEQUENCE.
        const explicitWrapper = contentInfoAsn1.value[1] as forge.asn1.Asn1
        const signedDataAsn1 = explicitWrapper.value[0] as forge.asn1.Asn1

        info.certificateChain = orderChainLeafToRoot(
          extractCertificates(signedDataAsn1),
        )

        // Preference order for the displayed signing time, most to least
        // trustworthy: (1) an embedded RFC 3161 timestamp-authority token
        // (id-aa-signatureTimeStampToken) — a third party's attested time,
        // cryptographically bound to the signature value itself, which is
        // what verification reports treat as authoritative for PAdES-T/LTA
        // signatures; (2) the CMS SignerInfo's authenticated `signingTime`
        // attribute — still covered by the signature, but just the signer's
        // own local-clock claim; (3) the PDF dict's `/M` entry, which isn't
        // covered by the signature at all.
        const signerInfo = parseFirstSignerInfo(signedDataAsn1)
        if (signerInfo?.signingTime) {
          info.signingTime = signerInfo.signingTime
        }
        if (signerInfo?.tsaTimestamp) {
          info.signingTime = signerInfo.tsaTimestamp
        }
        if (signerInfo) {
          info.signatureAlgorithmName = describeSignatureAlgorithm(
            signerInfo.signatureAlgorithmOid,
            signerInfo.digestAlgorithmOid,
          )
        }

        if (isTimestamp) {
          // RFC 3161 timestamps sign a TSTInfo message-imprint (a hash of the
          // outer signature bytes), not the PDF's /ByteRange content directly,
          // so the same integrity check doesn't apply here.
          info.integrityValid = null
          info.integrityError = null
        } else if (byteRange && signerInfo) {
          const { valid, error } = verifyByteRangeIntegrity(
            fileBytes,
            byteRange,
            signerInfo,
          )
          info.integrityValid = valid
          info.integrityError = error
        } else if (byteRange && !signerInfo) {
          info.integrityError = 'Could not parse SignerInfo from signature.'
        }

        if (info.certificateChain.length > 0) {
          info.chainVerification = await verifyCertificateChain(
            info.certificateChain,
            info.signingTime,
          )
          info.trustedRoot = checkTrustedRoot(info.certificateChain)
        }

        if (!isTimestamp) {
          info.notary = checkNotaryStatus(
            info.certificateChain[0] ?? null,
            info.signerName,
          )
        }
      } catch (err) {
        info.integrityError =
          err instanceof Error ? err.message : 'Failed to parse signature.'
      }
    }

    results.push(info)
  }

  assignTimestampOwners(results)

  return results
}

export type SignatureVerdictReason =
  | 'integrity-failed'
  | 'integrity-unknown'
  | 'chain-invalid'
  | 'chain-not-checked'
  | 'root-not-trusted'
  | 'root-revoked'

export interface SignatureVerdict {
  isValid: boolean
  reasons: SignatureVerdictReason[]
}

/**
 * Rolls a single signature's separate checks (content integrity, chain
 * cryptographic validity, and root-of-trust) up into the same yes/no
 * verdict a verification report gives per signature — "is this signature
 * cryptographically valid and anchored to a certificate authority we
 * actually trust." Timestamps aren't independently verdicted; they extend
 * their owning signature rather than making their own legal claim.
 */
export function getSignatureVerdict(sig: SignatureInfo): SignatureVerdict {
  const reasons: SignatureVerdictReason[] = []

  if (sig.integrityValid === false) reasons.push('integrity-failed')
  else if (sig.integrityValid === null) reasons.push('integrity-unknown')

  if (!sig.chainVerification) {
    reasons.push('chain-not-checked')
  } else if (
    !sig.chainVerification.allSignaturesValid ||
    !sig.chainVerification.allValidAtSigningTime
  ) {
    reasons.push('chain-invalid')
  }

  if (!sig.trustedRoot || sig.trustedRoot.status === 'not_found') {
    reasons.push('root-not-trusted')
  } else if (sig.trustedRoot.status === 'revoked') {
    reasons.push('root-revoked')
  }

  return { isValid: reasons.length === 0, reasons }
}

/**
 * Document-level "is this signed correctly and legally sound" verdict,
 * mirroring the single yes/no a verification report gives: every
 * (non-timestamp) signature in the document must itself verify. A document
 * with no signatures at all isn't "sound" in this sense — there's nothing
 * to trust — so it verdicts false rather than vacuously true.
 */
export function getDocumentVerdict(signatures: SignatureInfo[]): boolean {
  const nonTimestamp = signatures.filter((s) => !s.isTimestamp)
  if (nonTimestamp.length === 0) return false
  return nonTimestamp.every((s) => getSignatureVerdict(s).isValid)
}

/**
 * PAdES-LTA embeds a document timestamp (`/Type /DocTimeStamp`) after each
 * signature it extends, rather than as an independent, separately-reported
 * signature — matching how verification reports (and eIDAS validators)
 * describe them. Byte ranges aren't contiguous (DSS/revocation data can be
 * appended in between), so ownership is inferred from append order: a
 * timestamp belongs to the most recent non-timestamp signature that
 * preceded it in the file, ranked by where each signature's second
 * /ByteRange segment starts (i.e. how far into the file it was written).
 */
function assignTimestampOwners(signatures: SignatureInfo[]): void {
  const byAppendOrder = signatures
    .filter((s) => s.byteRange)
    .map((s) => ({ sig: s, appendOffset: s.byteRange![2] }))
    .sort((a, b) => a.appendOffset - b.appendOffset)

  for (const { sig, appendOffset } of byAppendOrder) {
    if (!sig.isTimestamp) continue
    const owner = [...byAppendOrder]
      .reverse()
      .find((e) => !e.sig.isTimestamp && e.appendOffset < appendOffset)
    if (owner) sig.timestampFor = owner.sig.index
  }
}

function hexToBinaryString(hex: string): string {
  let out = ''
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

export function parsePdfDate(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(
    /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([+-Zz])?(\d{2})?'?(\d{2})?'?/,
  )
  if (!m) return raw
  const [, y, mo, d, h = '00', mi = '00', s = '00', tzSign, tzH, tzM] = m
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  if (tzSign === 'Z' || tzSign === 'z' || !tzSign) {
    iso += 'Z'
  } else {
    iso += `${tzSign}${tzH ?? '00'}:${tzM ?? '00'}`
  }
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? raw : date.toISOString()
}

export async function computeFileHash(
  fileBytes: Uint8Array,
): Promise<{ algorithm: string; base64: string; hex: string }> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    fileBytes.slice().buffer,
  )
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return {
    algorithm: 'SHA-256',
    base64: btoa(binary),
    hex: Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  }
}
