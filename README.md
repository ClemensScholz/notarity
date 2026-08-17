# notarity: Signature Validator

A click-dummy for the Product Engineer take-home assignment: upload a signed PDF and see its
embedded cryptographic signatures, notary status, and "notarized on notarity" status, entirely
client-side, nothing is uploaded anywhere.

## Running it

```bash
npm install
npm run dev
```

## What's implemented

1. **Embedded cryptographic signatures.** Signer, signing time, signature type/level (CAdES /
   PAdES), certificate details (subject, issuer, serial, validity, key usage, QC statements/QSCD),
   and full certificate chain verification with per-link and root-of-trust badges.
2. **Notary detection & registry check** (mocked). If a signature's certificate matches a name in
   the mock notary registry, the signer is flagged as a notary, with jurisdiction and registration
   status.
3. **"Notarized on notarity" check + audit trail** (mocked). If the uploaded file's hash matches a
   mock record, the document is flagged as validated & notarized, with an audit trail of who signed
   when and which notary notarized it.
4. **My own feature: batch checking.** The dashboard supports uploading and checking multiple
   documents at once. People who'd reach for a tool like this are probably verifying documents
   regularly, not one at a time, so batching felt like the highest-value small addition given the
   time box.

## How I built this / assumptions / decisions

I'd never worked with PDF signatures before this assignment, so the process was very much
learn-by-building:

- **Started as a rough metadata dummy.** First version just uploaded a PDF and dumped whatever
  metadata I could extract, so I could get oriented. I continuously cross-checked what I was
  parsing against the [reference verification tool linked in the assignment](https://www.rtr.at/TKP/was_wir_tun/vertrauensdienste/Signatur/signaturpruefung/Pruefung.de.html)
  to make sure the signature/certificate data I was showing was actually correct, not just
  plausible-looking.
- **Rendering the PDF page itself was a self-imposed requirement,** not something the assignment
  asked for. I wanted the prototype to feel like a real product, not just a data dump, so I built
  a PDF page viewer alongside the signature data.
- **A feature I built and then discarded:** highlighting, directly on the rendered PDF page, which
  parts of the document were changed after a given signature. I got a working prototype, but then
  realized the premise doesn't hold up: common signing tools don't let you append new content to
  an already-signed document in a way that would show up as an in-page edit like that. I kept the
  underlying "what changed after this signature" check (it's still in the timeline, per signature)
  but dropped the in-PDF highlighting.
- **Other feature ideas I considered and set aside:**
  - *Simple vs. expert mode.* On reflection this wasn't really a feature, more a UX obligation I
    should meet regardless. So instead of building a mode toggle, I just focused on keeping the
    default view as clean as possible throughout.
  - *"Is this signer entitled to sign for their company?"* Verifying, e.g. via a national company
    registry, that a signer is actually authorized to sign on behalf of the organization on their
    certificate. Interesting, but it's a large feature with real research needed (which registries,
    which countries, what data is even available), out of scope for the time box.
  - *Batch mode.* This is the one I went with (see above).
- **No data is stored or persisted.** Everything lives in memory for the current session only,
  matching the "nothing is uploaded anywhere" promise. An account/history feature (so you can see
  what you've checked before) felt like a reasonable next step, but is a real scope decision that
  depends on actual user need, not something to bolt on speculatively.
- **Small UX decisions along the way:** e.g. I originally auto-navigated into the document detail
  view right after the first upload, but that made the flow feel abrupt rather than smooth, so I
  removed it. Uploading now always lands you back on the dashboard, and you choose when to open a
  document.

### How I tested it

Manual testing against the sample documents (the provided `PoA_signed_sample.pdf` plus a few
fixtures I generated myself, see `scripts/`), cross-checking signature/certificate output against
the RTR reference tool linked in the assignment, plus a few edited/tampered PDFs to confirm the
integrity and "changes since this signature" checks correctly flag them as invalid/altered.

### Tools used

Built with AI assistance (Claude Code) throughout, as explicitly encouraged by the assignment,
used for implementation, iterating on the ASN.1/certificate-chain parsing, and UI cleanup.
Photos of intermediate whiteboard/paper sketches and screenshots from throughout the process are
available and will be shared during the review presentation.

## Known flaws / out of scope

- The individual signature detail sections could use a real design pass. The information density
  and layout there still feels a bit ad hoc rather than deliberately designed.
- The "Notarity audit trail" card is its own separate block because the assignment specifically
  asks for it, but a lot of that information already lives in the timeline above it. I'd like to
  explore folding the two together rather than showing it twice.
- Mobile isn't finished. The timeline works well on desktop, but on smaller screens it gets
  cramped and information gets truncated, needs dedicated responsive work.
- All notary/registry/"notarized on notarity" data is mocked, as instructed by the assignment. No
  real backend or registry is queried.
- This is a first dummy. It would benefit from a round of outside/stakeholder feedback before it's
  something you'd actually ship.

## Ideas for later

- **Proof without re-upload.** Right now, proving a document is validated means handing someone the
  whole PDF so they can upload it themselves. It'd be nice to generate a small downloadable
  "validation record" PDF, or a shareable link back to this validator, so you can prove validity
  without redistributing the full document. Exact shape depends on user need.
- **Upsell back to the notarity platform.** If a document is validated but *not* notarized on
  notarity, that's a natural moment to surface "you could get this notarized on notarity," turning
  the checker into a funnel back to the core product, not just a standalone utility.
- **Accounts / history**, if there's real user demand for seeing what you've checked before.
- Finish the responsive/mobile layout.
- A real design pass on the signature detail sections.
