// Generates a minimal, hand-built single-page PDF (an Austrian affidavit,
// in German) signed by a notary registered in the mocked notary registry
// (src/notaryRegistry.ts) — a test fixture for the notary-detection
// feature. Not a copy of any real PDF; built from scratch so we don't need
// to surgically edit a complex existing file's xref table.
const fs = require('fs');
const path = require('path');
const { buildMultiSignedPdf } = require('./pdf-fixture-lib.cjs');

const OUT_PATH = path.join(__dirname, '..', 'public', 'notary-sample.pdf');

const BODY_LINES = [
  'EIDESSTATTLICHE ERKLÄRUNG',
  '',
  'Ich, die unterzeichnete Person, erkläre hiermit an Eides statt, dass',
  'die in diesem Dokument gemachten Angaben der Wahrheit entsprechen',
  'und nach bestem Wissen und Gewissen vollständig und richtig sind.',
  'Diese eidesstattliche Erklärung wird zum Zweck der Identitätsbe-',
  'stätigung im Zusammenhang mit dem beigefügten Schriftverkehr',
  'abgegeben.',
  '',
  'Mir ist bekannt, dass eine falsche eidesstattliche Erklärung nach',
  'den einschlägigen Bestimmungen des österreichischen Strafrechts',
  'strafbar ist.',
  '',
  'ZU URKUND DESSEN habe ich diese Erklärung am unten angeführten',
  'Datum vor einem öffentlichen Notar unterfertigt, welcher meine',
  'Identität festgestellt hat.',
]

const signed = buildMultiSignedPdf({
  bodyLines: BODY_LINES,
  signers: [
    {
      subjectAttrs: [
        { name: 'commonName', value: 'Amelia J. Harrow' },
        { name: 'stateOrProvinceName', value: 'Wien' },
        { name: 'countryName', value: 'AT' },
      ],
      caName: 'AT-Notariat-CA',
      caSubjectAttrs: [
        { name: 'commonName', value: 'Notariatskammer Qualified CA 2024' },
        { name: 'organizationName', value: 'Österreichische Notariatskammer' },
        { name: 'countryName', value: 'AT' },
      ],
      cpsUrl: 'https://www.notar.at/cps/',
      pdsUrl: 'https://www.notar.at/pds/de/',
      signerName: 'Amelia J. Harrow',
      reason: 'Beurkundung (Notarization of document)',
      location: 'Wien, Österreich',
      signedAt: new Date('2026-02-01T13:00:00Z'),
    },
  ],
})

fs.writeFileSync(OUT_PATH, Buffer.from(signed, 'binary'));
console.log('Wrote', OUT_PATH, `(${Buffer.byteLength(signed, 'binary')} bytes)`);
