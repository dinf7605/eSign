'use strict';
// CMS/RFC 3161 조립·해석에 함께 쓰는 ASN.1 도우미 (node-forge 기반) + 인증서 체인 확인
const crypto = require('crypto');
const forge = require('node-forge');

const { asn1 } = forge;
const U = asn1.Class.UNIVERSAL;
const CTX = asn1.Class.CONTEXT_SPECIFIC;
const T = asn1.Type;

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  ekuTimeStamping: '1.3.6.1.5.5.7.3.8',
};
const HASH_BY_OID = { [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512', [OID.sha1]: 'sha1' };

const oid = (o) => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes());
const seq = (items) => asn1.create(U, T.SEQUENCE, true, items);
const set = (items) => asn1.create(U, T.SET, true, items);
const octet = (buf) => asn1.create(U, T.OCTETSTRING, false, Buffer.from(buf).toString('binary'));
const int = (n) => asn1.create(U, T.INTEGER, false, asn1.integerToDer(n).getBytes());
/** 양수 큰 정수 (난수 nonce·일련번호용) — 맨 앞 비트가 1이면 0x00을 붙인다 */
const bigInt = (buf) => asn1.create(U, T.INTEGER, false, Buffer.concat([buf[0] & 0x80 ? Buffer.from([0]) : Buffer.alloc(0), buf]).toString('binary'));
const bool = (v) => asn1.create(U, T.BOOLEAN, false, v ? '\xff' : '\x00');
const nul = () => asn1.create(U, T.NULL, false, '');
const ctx = (tag, items) => asn1.create(CTX, tag, true, items);
const der = (node) => Buffer.from(asn1.toDer(node).getBytes(), 'binary');
const fromDer = (buf) => asn1.fromDer(forge.util.createBuffer(Buffer.from(buf).toString('binary')), { decodeBitStrings: false });
const oidOf = (node) => asn1.derToOid(node.value);
const bytesOf = (node) => Buffer.from(node.value, 'binary');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/** DER SET OF 은 인코딩 바이트 순으로 정렬해야 한다 */
function derSorted(nodes) {
  return nodes
    .map((node) => ({ node, bytes: der(node) }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map((x) => x.node);
}

/** DER 원소 하나의 위치: { start, contentStart, end } */
function readTlv(buf, offset = 0) {
  if (offset + 2 > buf.length) throw new Error('ASN.1 데이터가 잘렸습니다.');
  const first = buf[offset + 1];
  let len = first;
  let header = 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw new Error('지원하지 않는 ASN.1 길이 형식입니다.');
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[offset + 2 + i];
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new Error('ASN.1 데이터가 잘렸습니다.');
  return { start: offset, contentStart: offset + header, end };
}

/** 인증서 DER에서 발급자(Name)와 일련번호 ASN.1 노드를 꺼낸다 */
function issuerAndSerial(certDer) {
  const tbs = fromDer(certDer).value[0];
  const off = tbs.value[0].tagClass === CTX ? 1 : 0; // [0] version 이 있으면 한 칸 밀림
  return { serial: tbs.value[off], issuer: tbs.value[off + 2] };
}

/** ESSCertIDv2 { certHash(SHA-256) , issuerSerial } — signing-certificate-v2 속성 값 */
function signingCertificateV2(certDer) {
  const { issuer, serial } = issuerAndSerial(certDer);
  const essCertIdV2 = seq([octet(sha256(certDer)), seq([seq([ctx(4, [issuer])]), serial])]);
  return seq([seq([essCertIdV2])]);
}

/** 서명 속성(signedAttrs)에 대한 서명 검증: RSA PKCS#1 v1.5 · RSA-PSS · ECDSA 모두 시도 */
function verifySignedBytes(hashName, data, cert, signature) {
  const tries = [
    () => crypto.verify(hashName, data, cert.publicKey, signature),
    () => crypto.verify(hashName, data, {
      key: cert.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO,
    }, signature),
  ];
  return tries.some((t) => {
    try {
      return t();
    } catch {
      return false;
    }
  });
}

function chainIsTrusted(leaf, embedded, trustedCas) {
  let current = leaf;
  for (let depth = 0; depth < 6; depth += 1) {
    if (trustedCas.some((ca) => ca.ca && current.checkIssued(ca) && current.verify(ca.publicKey))) return true;
    if (trustedCas.some((ca) => ca.fingerprint256 === current.fingerprint256)) return true;
    const next = embedded.find((c) => c !== current && c.ca && current.checkIssued(c) && current.verify(c.publicKey));
    if (!next) return false;
    current = next;
  }
  return false;
}

function cnOf(dn) {
  return (/CN=([^\n]+)/.exec(dn) || [])[1] || dn;
}

module.exports = {
  asn1, U, CTX, T, OID, HASH_BY_OID,
  oid, seq, set, octet, int, bigInt, bool, nul, ctx, der, fromDer, oidOf, bytesOf, sha256,
  derSorted, readTlv, issuerAndSerial, signingCertificateV2, verifySignedBytes, chainIsTrusted, cnOf,
};
