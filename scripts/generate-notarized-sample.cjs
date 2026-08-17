// Generates a fixture PDF whose exact SHA-256 hash is registered in the
// mocked "notarized on notarity" lookup (src/notarityRegistry.ts). Uploading
// this exact file demonstrates the "Notarized on notarity" badge and audit
// trail; any edit to the file changes its hash and the badge correctly
// disappears, since the check is hash-based by design.
//
// A Spanish power of attorney ("poder notarial"), in Spanish, with two
// Spanish signing parties and a Swedish notary attesting on top — a
// legitimate cross-border EU notarization scenario. Each signature is a
// genuine incremental PDF revision covering everything before it, the same
// structure real multi-signature PDFs use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildMultiSignedPdf } = require('./pdf-fixture-lib.cjs');

const OUT_PATH = path.join(
  __dirname,
  '..',
  'public',
  'notarized-on-notarity-sample.pdf',
);

const BODY_LINES = [
  'PODER NOTARIAL',
  '',
  'CONSTE POR EL PRESENTE DOCUMENTO que yo, María Dolores Fernández',
  'Ruiz, en calidad de Poderdante, otorgo poder a favor de Javier',
  'Antonio Moreno García, para que en mi nombre y representación',
  'realice cuantos actos sean necesarios en relación con los siguientes',
  'asuntos, en la medida permitida por la ley:',
  '',
  '  1. Operaciones sobre bienes inmuebles',
  '  2. Gestiones bancarias y financieras',
  '  3. Trámites administrativos y fiscales',
  '  4. Contratación de seguros',
  '',
  'El presente poder no se verá afectado por la incapacidad',
  'sobrevenida del Poderdante y permanecerá en pleno vigor hasta su',
  'revocación por escrito.',
  '',
  'EN TESTIMONIO DE LO CUAL, el Poderdante y el Apoderado firman el',
  'presente documento, quedando reconocido ante notario según se',
  'indica a continuación.',
]

const ES_CA = {
  caName: 'ES-Qualified-CA',
  caSubjectAttrs: [
    { name: 'commonName', value: 'FNMT Persona Física CA' },
    { name: 'organizationName', value: 'Fábrica Nacional de Moneda y Timbre' },
    { name: 'countryName', value: 'ES' },
  ],
  cpsUrl: 'https://www.sede.fnmt.gob.es/cps/',
  pdsUrl: 'https://www.sede.fnmt.gob.es/pds/es/',
}

const SE_CA = {
  caName: 'SE-Notarius-CA',
  caSubjectAttrs: [
    { name: 'commonName', value: 'Notarius Publicus Qualified CA' },
    { name: 'organizationName', value: 'Länsstyrelsen Sverige' },
    { name: 'countryName', value: 'SE' },
  ],
  cpsUrl: 'https://www.lansstyrelsen.se/cps/',
  pdsUrl: 'https://www.lansstyrelsen.se/pds/sv/',
}

const signed = buildMultiSignedPdf({
  bodyLines: BODY_LINES,
  signers: [
    {
      subjectAttrs: [
        { name: 'commonName', value: 'María Dolores Fernández Ruiz' },
        { name: 'countryName', value: 'ES' },
        { name: 'stateOrProvinceName', value: 'Madrid' },
      ],
      ...ES_CA,
      signerName: 'María Dolores Fernández Ruiz',
      reason: 'Poderdante - otorga el poder notarial',
      location: 'Madrid, España',
      signedAt: new Date('2026-03-12T15:20:00Z'),
    },
    {
      subjectAttrs: [
        { name: 'commonName', value: 'Javier Antonio Moreno García' },
        { name: 'countryName', value: 'ES' },
        { name: 'stateOrProvinceName', value: 'Madrid' },
      ],
      ...ES_CA,
      signerName: 'Javier Antonio Moreno García',
      reason: 'Apoderado - acepta el nombramiento',
      location: 'Madrid, España',
      signedAt: new Date('2026-03-12T15:25:00Z'),
    },
    {
      subjectAttrs: [
        { name: 'commonName', value: 'Anna Lindqvist' },
        { name: 'countryName', value: 'SE' },
        { name: 'stateOrProvinceName', value: 'Stockholm' },
      ],
      ...SE_CA,
      signerName: 'Anna Lindqvist',
      reason: 'Notarized via notarity platform',
      location: 'Stockholm, Sweden',
      signedAt: new Date('2026-03-12T15:30:00Z'),
    },
  ],
})

const buffer = Buffer.from(signed, 'binary');
fs.writeFileSync(OUT_PATH, buffer);

const hash = crypto.createHash('sha256').update(buffer).digest('base64');
console.log('Wrote', OUT_PATH, `(${buffer.byteLength} bytes)`);
console.log('SHA-256 (base64):', hash);
console.log(
  '\nRegister this hash in src/notarityRegistry.ts MOCK_NOTARIZED_DOCUMENTS.',
);
