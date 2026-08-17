// Shared helpers for generating minimal, hand-built, signed PDF fixtures
// with realistic body text and support for multiple sequential signatures
// (each appended as a true PDF incremental update, the same way real
// multi-signature PDFs are structured — not a single-shot fabrication).
const forge = require('node-forge');

// RFC 3739 / ETSI EN 319 412-5 QC statement OIDs — same ones our own
// extraction code (src/pdfSignatures.ts) already recognizes, so a mocked
// qualified-certificate signature reads the same way a real one does.
const OID_QC_STATEMENTS = '1.3.6.1.5.5.7.1.3'
const OID_QC_COMPLIANCE = '0.4.0.1862.1.1'
const OID_QC_TYPE = '0.4.0.1862.1.6'
const OID_QC_TYPE_ESIGN = '0.4.0.1862.1.6.1'
const OID_QC_PDS = '0.4.0.1862.1.5'
const OID_QC_SSCD = '1.3.6.1.5.5.7.11.2'

/** Hand-builds a QCStatements extension value (the DER content of the
 * extension, before it's wrapped as an OCTET STRING extension value):
 * QcCompliance + QcType(esign) + QcSSCD + a QcPDS pointing at a fake URL. */
function buildQcStatementsDer(pdsUrl) {
  const oidSeq = (oid) =>
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(oid).getBytes()),
    ])

  const qcCompliance = oidSeq(OID_QC_COMPLIANCE)
  const qcSscd = oidSeq(OID_QC_SSCD)

  const qcType = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(OID_QC_TYPE).getBytes()),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(OID_QC_TYPE_ESIGN).getBytes()),
    ]),
  ])

  const qcPds = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(OID_QC_PDS).getBytes()),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.IA5STRING, false, pdsUrl),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.PRINTABLESTRING, false, 'EN'),
      ]),
    ]),
  ])

  const statements = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [qcCompliance, qcType, qcSscd, qcPds],
  )
  return forge.asn1.toDer(statements).getBytes()
}

/** Generates a fake root/intermediate CA cert + key pair — the issuer for
 * signer certs, so fixtures show a real (if fictional) certificate chain
 * instead of a bare self-signed leaf. */
function generateMockCa(subjectAttrs) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '1000';
  cert.validity.notBefore = new Date('2020-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2035-01-01T00:00:00Z');
  cert.setSubject(subjectAttrs);
  cert.setIssuer(subjectAttrs); // root: self-signed
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, privateKey: keys.privateKey };
}

/**
 * Generates a signer certificate issued by a mock CA (not self-signed),
 * with mocked QCStatements and a certificatePolicies/CPS URL — so fixtures
 * present a certificate chain and "qualified certificate" fields the same
 * shape a real EU qualified-signing platform's certificate would have.
 */
function generateSignerCertificate(subjectAttrs, ca, { cpsUrl, pdsUrl }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e15) + 1);
  cert.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2029-01-01T00:00:00Z');
  cert.setSubject(subjectAttrs);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    {
      name: 'certificatePolicies',
      value: forge.asn1
        .toDer(
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
              forge.asn1.create(
                forge.asn1.Class.UNIVERSAL,
                forge.asn1.Type.OID,
                false,
                forge.asn1.oidToDer('2.23.140.1.2.1').getBytes(), // generic "domain-validated"-style policy OID, standing in for a real QCP-n policy OID
              ),
              forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
                forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
                  forge.asn1.create(
                    forge.asn1.Class.UNIVERSAL,
                    forge.asn1.Type.OID,
                    false,
                    forge.asn1.oidToDer('1.3.6.1.5.5.7.2.1').getBytes(), // id-qt-cps
                  ),
                  forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.IA5STRING, false, cpsUrl),
                ]),
              ]),
            ]),
          ]),
        )
        .getBytes(),
    },
    {
      id: OID_QC_STATEMENTS,
      critical: false,
      value: buildQcStatementsDer(pdsUrl),
    },
  ]);
  cert.sign(ca.privateKey, forge.md.sha256.create());
  return { cert, privateKey: keys.privateKey };
}

const PLACEHOLDER_LENGTH = 8192; // hex chars reserved per /Contents

function pdfDate(date) {
  // PDF date format: D:YYYYMMDDHHmmSSZ (no "T" separator, unlike ISO 8601).
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/T/, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Converts a normal JS (UTF-16) string into a "binary string" — one JS char
 * per output byte, each in the 0x00-0xFF range — matching PDFDocEncoding /
 * WinAnsiEncoding for the Latin-1-range characters this library uses (e.g.
 * äöüß, éíóñá). This must be applied to any user-provided text before it's
 * embedded, since the rest of this file treats strings as byte-strings
 * throughout (using .length/indexOf/slice as byte offsets) — mixing in a
 * plain UTF-16 string with a character outside Latin-1 would silently
 * corrupt those offsets (Buffer.byteLength(s, 'binary') truncates each
 * UTF-16 code unit to a byte rather than raising an error).
 */
function toLatin1BinaryString(s) {
  const buf = Buffer.from(s, 'latin1');
  if (buf.toString('latin1') !== s) {
    throw new Error(
      `Fixture text contains a character outside Latin-1: ${JSON.stringify(s)}`,
    );
  }
  return buf.toString('binary');
}

function escapePdfString(s) {
  return toLatin1BinaryString(s).replace(/([()\\])/g, '\\$1');
}

/** Lays out an array of body-text lines as a simple Helvetica content stream. */
function buildContentStream(lines) {
  const ops = ['BT', '/F1 12 Tf', '14 TL', '72 740 Td'];
  lines.forEach((line, i) => {
    if (i > 0) ops.push('T*');
    ops.push(`(${escapePdfString(line)}) Tj`);
  });
  ops.push('ET');
  return ops.join('\n');
}

/** Serializes a full set of objects (used only for the base revision) into a
 * complete PDF byte string with header, objects, xref table, and trailer. */
function serializeRevision(objects, { rootObjNum, prevXrefOffset, startOffset }) {
  let pdf = startOffset === 0 ? '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n' : ''
  const offsets = new Map()

  const objNums = [...objects.keys()].sort((a, b) => a - b)
  for (const num of objNums) {
    offsets.set(num, startOffset + Buffer.byteLength(pdf, 'binary'))
    pdf += `${num} 0 obj\n${objects.get(num)}\nendobj\n`
  }

  const xrefOffset = startOffset + Buffer.byteLength(pdf, 'binary')
  const maxObjNum = Math.max(...objNums)
  let xref = `xref\n0 1\n0000000000 65535 f \n`
  for (const num of objNums) {
    xref += `${num} 1\n${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`
  }
  let trailer = `trailer\n<< /Size ${maxObjNum + 1} /Root ${rootObjNum} 0 R`
  if (prevXrefOffset !== null) trailer += ` /Prev ${prevXrefOffset}`
  trailer += ` >>\nstartxref\n${xrefOffset}\n%%EOF`

  return { text: pdf + xref + trailer, xrefOffset }
}

/**
 * Appends an incremental update that revises the page's content stream
 * (object 4) with new body text — an unsigned edit to the visible page,
 * the same way a real editor adding a clause/annotation between two
 * signings would show up. Whichever signature comes next will naturally
 * cover this revision too, since its /ByteRange starts from byte 0.
 */
function appendContentRevision({ baseText, prevXrefOffset, bodyLines, maxObjNum }) {
  const contentStream = buildContentStream(bodyLines)
  const startOffset = Buffer.byteLength(baseText, 'binary')
  const objText = `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'binary')} >>\nstream\n${contentStream}\nendstream\nendobj\n`

  const xrefOffset = startOffset + Buffer.byteLength(objText, 'binary')
  const xref = `xref\n4 1\n${String(startOffset).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R /Prev ${prevXrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF`

  return { text: baseText + objText + xref + trailer, xrefOffset }
}

/**
 * Appends one incremental update to `baseText` that fills in signature slot
 * `slotIndex` (0-based) with a new /Sig dict, updates that slot's widget to
 * reference it, and re-signs the byte range covering everything up to and
 * including this revision (the same layered structure real multi-signature
 * PDFs use — each signature covers everything before it, not the whole
 * final file).
 */
function appendSignatureRevision({
  baseText,
  prevXrefOffset,
  slotIndex,
  sigObjNum,
  widgetObjNum,
  signerName,
  reason,
  location,
  signedAt,
  cert,
  privateKey,
  caCert,
}) {
  const dateStr = pdfDate(signedAt)
  const contentsPlaceholder = '0'.repeat(PLACEHOLDER_LENGTH)
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]'

  const sigDictText =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
    `/ByteRange ${byteRangePlaceholder} /Contents <${contentsPlaceholder}> ` +
    `/Name (${escapePdfString(signerName)}) /Reason (${escapePdfString(reason)}) ` +
    `/Location (${escapePdfString(location)}) /M (D:${dateStr}) >>`

  const startOffset = Buffer.byteLength(baseText, 'binary')
  let appended = ''
  const objOffsets = new Map()

  objOffsets.set(sigObjNum, startOffset + Buffer.byteLength(appended, 'binary'))
  appended += `${sigObjNum} 0 obj\n${sigDictText}\nendobj\n`

  // Rewritten widget object pointing /V at the new signature dict.
  objOffsets.set(widgetObjNum, startOffset + Buffer.byteLength(appended, 'binary'))
  const y = 60 - slotIndex * 20
  appended +=
    `${widgetObjNum} 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig ` +
    `/Rect [72 ${y} 300 ${y + 15}] /P 3 0 R /T (Signature${slotIndex + 1}) ` +
    `/V ${sigObjNum} 0 R >>\nendobj\n`

  const xrefOffset = startOffset + Buffer.byteLength(appended, 'binary')
  let xref = `xref\n`
  for (const [num, off] of objOffsets) {
    xref += `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${widgetObjNum + 1} /Root 1 0 R /Prev ${prevXrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF`

  const unsignedFull = baseText + appended + xref + trailer

  // Sign everything from byte 0 up to (but not including) this revision's
  // own /Contents value — i.e. this signature covers the base document plus
  // any earlier signature revisions, matching real layered-signature PDFs.
  const contentsMarker = '/Contents <'
  const contentsStart =
    unsignedFull.indexOf(contentsMarker, startOffset) + contentsMarker.length
  const contentsEnd = unsignedFull.indexOf('>', contentsStart)

  const byteRangeMarker = '/ByteRange '
  const byteRangeBracketStart =
    unsignedFull.indexOf(byteRangeMarker, startOffset) + byteRangeMarker.length
  const byteRangeBracketEnd = unsignedFull.indexOf(']', byteRangeBracketStart) + 1

  const range = [
    0,
    contentsStart - 1,
    contentsEnd + 1,
    unsignedFull.length - contentsEnd - 1,
  ]
  const rangeStr = `[${range[0]} ${range[1]} ${range[2]} ${range[3]}]`
  const paddedRangeStr = rangeStr.padEnd(byteRangeBracketEnd - byteRangeBracketStart, ' ')
  let patched =
    unsignedFull.slice(0, byteRangeBracketStart) +
    paddedRangeStr +
    unsignedFull.slice(byteRangeBracketEnd)

  const part1 = patched.slice(range[0], range[0] + range[1])
  const part2 = patched.slice(range[2], range[2] + range[3])
  const signedContent = part1 + part2

  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(signedContent, 'binary')
  p7.addCertificate(cert)
  if (caCert) p7.addCertificate(caCert)
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signedAt },
    ],
  })
  p7.sign({ detached: true })

  const signedAsn1 = p7.toAsn1()
  // node-forge's pkcs7.addSigner always writes signatureAlgorithm as plain
  // "rsaEncryption" regardless of the digest used — real signing tools
  // almost universally use the combined "sha256WithRSAEncryption" OID here
  // instead, so patch it in to match what real signatures look like.
  const signedData = signedAsn1.value[1].value[0]
  const universalSets = signedData.value.filter(
    (v) => v.type === forge.asn1.Type.SET && v.tagClass === forge.asn1.Class.UNIVERSAL,
  )
  const signerInfo = universalSets[universalSets.length - 1].value[0]
  const sigAlgOidNode = signerInfo.value[4].value[0]
  sigAlgOidNode.value = forge.asn1.oidToDer(forge.pki.oids.sha256WithRSAEncryption).getBytes()

  const der = forge.asn1.toDer(signedAsn1).getBytes()
  const derHex = forge.util.bytesToHex(der)
  if (derHex.length > PLACEHOLDER_LENGTH) {
    throw new Error(`Signature DER too large: ${derHex.length} > ${PLACEHOLDER_LENGTH}`)
  }
  const paddedHex = derHex + '0'.repeat(PLACEHOLDER_LENGTH - derHex.length)

  const signed = patched.slice(0, contentsStart) + paddedHex + patched.slice(contentsEnd)
  return { text: signed, xrefOffset }
}

/**
 * Builds a PDF with realistic multi-line body text and one or more
 * sequential signatures, each a real incremental update layered on top of
 * the previous revision (mirroring genuine multi-party + notary documents).
 *
 * `signers`: array of { subjectAttrs, signerName, reason, location, signedAt,
 * caName, caSubjectAttrs, cpsUrl, pdsUrl, contentChangeBefore } applied in
 * order — the last one is typically the notary. Signers sharing the same
 * `caName` are issued by the same (fake) CA, so fixtures can mirror how a
 * real multi-signature document may have several signers under one trust
 * provider. `contentChangeBefore`, if set, is a new bodyLines array that
 * replaces the page's visible content in an unsigned incremental update
 * right before that signer signs — for testing "what changed after a
 * signature" style features against a genuine visible edit.
 */
function buildMultiSignedPdf({ bodyLines, signers }) {
  const base = serializeRevision(
    (() => {
      const objects = new Map()
      const sigFieldRefs = signers.map((_, i) => `${10 + i} 0 R`)
      objects.set(
        1,
        `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${sigFieldRefs.join(' ')}] /SigFlags 3 >> >>`,
      )
      objects.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      const contentStream = buildContentStream(bodyLines)
      objects.set(
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ` +
          `/Annots [${sigFieldRefs.join(' ')}] >>`,
      )
      objects.set(
        4,
        `<< /Length ${Buffer.byteLength(contentStream, 'binary')} >>\nstream\n${contentStream}\nendstream`,
      )
      // WinAnsiEncoding must be declared explicitly — without it, a base
      // Type1 font falls back to StandardEncoding, which doesn't place
      // äöüßéíóñá etc. at the same byte values our Latin-1 text assumes.
      objects.set(
        5,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      )
      signers.forEach((_, i) => {
        const y = 60 - i * 20
        objects.set(
          10 + i,
          `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [72 ${y} 300 ${y + 15}] ` +
            `/P 3 0 R /T (Signature${i + 1}) >>`,
        )
      })
      return objects
    })(),
    { rootObjNum: 1, prevXrefOffset: null, startOffset: 0 },
  )

  let currentText = base.text
  let currentXrefOffset = base.xrefOffset

  const caByName = new Map()
  const getCa = (signer) => {
    if (!caByName.has(signer.caName)) {
      caByName.set(signer.caName, generateMockCa(signer.caSubjectAttrs))
    }
    return caByName.get(signer.caName)
  }

  // Highest object number ever allocated: sigObjNum = 20 + i*2 for the last
  // signer dominates widgetObjNum = 10 + i once there's more than one signer.
  const maxObjNum = Math.max(10 + signers.length - 1, 20 + (signers.length - 1) * 2)

  signers.forEach((signer, i) => {
    if (signer.contentChangeBefore) {
      const contentResult = appendContentRevision({
        baseText: currentText,
        prevXrefOffset: currentXrefOffset,
        bodyLines: signer.contentChangeBefore,
        maxObjNum,
      })
      currentText = contentResult.text
      currentXrefOffset = contentResult.xrefOffset
    }

    const ca = getCa(signer)
    const { cert, privateKey } = generateSignerCertificate(signer.subjectAttrs, ca, {
      cpsUrl: signer.cpsUrl,
      pdsUrl: signer.pdsUrl,
    })
    const sigObjNum = 20 + i * 2
    const widgetObjNum = 10 + i // reuse the pre-declared widget object number

    const result = appendSignatureRevision({
      baseText: currentText,
      prevXrefOffset: currentXrefOffset,
      slotIndex: i,
      sigObjNum,
      widgetObjNum,
      signerName: signer.signerName,
      reason: signer.reason,
      location: signer.location,
      signedAt: signer.signedAt,
      cert,
      privateKey,
      caCert: ca.cert,
    })
    currentText = result.text
    currentXrefOffset = result.xrefOffset
  })

  return currentText
}

module.exports = { buildMultiSignedPdf }
