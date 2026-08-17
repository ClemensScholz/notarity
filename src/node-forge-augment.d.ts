// @types/node-forge doesn't declare a few real runtime APIs we rely on for
// ASN.1/X.509 parsing (verified against node_modules/node-forge/lib source):
// `fromDer`'s options-object overload, and `pki.RDNAttributesAsArray` /
// `pki.certificateExtensionFromAsn1`, which exist in forge's JS but aren't
// in the type definitions.
import 'node-forge'

declare module 'node-forge' {
  namespace asn1 {
    interface FromDerOptions {
      strict?: boolean
      parseAllBytes?: boolean
      decodeBitStrings?: boolean
    }

    function fromDer(
      bytes: Bytes | util.ByteBuffer,
      options?: boolean | FromDerOptions,
    ): Asn1
  }

  namespace pki {
    interface RdnAttribute {
      type: string
      value: string
      valueTagClass: number
      name?: string
      shortName?: string
    }

    function RDNAttributesAsArray(
      rdn: asn1.Asn1,
      md?: forge.md.MessageDigest,
    ): RdnAttribute[]

    interface CertificateExtension {
      id: string
      critical: boolean
      value: string
      name?: string
      [key: string]: unknown
    }

    function certificateExtensionFromAsn1(ext: asn1.Asn1): CertificateExtension
  }
}
