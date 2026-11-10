'use strict';
// PAdES Baseline B-B / B-T 서명(ETSI.CAdES.detached)을 만들고 검증한다. (B-T = B-B + RFC 3161 타임스탬프)
//
// CMS SignedData 구조를 node-forge의 ASN.1 도구로 직접 조립한다.
//  - forge의 PKCS#7 서명기는 PAdES가 요구하는 signing-certificate-v2 속성을 넣지 못하고,
//    PAdES에서 쓰면 안 되는 signing-time 속성을 넣기 때문.
//  - 실제 RSA 서명/검증은 Node 내장 crypto가 한다.
const crypto = require('crypto');
const { Signer } = require('@signpdf/utils');
const {
  CTX, OID, HASH_BY_OID, oid, seq, set, octet, int, nul, ctx, der, fromDer, oidOf, bytesOf, sha256,
  derSorted, issuerAndSerial, signingCertificateV2, chainIsTrusted, cnOf,
} = require('./asn1');
const { requestTimestamp, verifyTimestampToken } = require('./tsa');

/**
 * 분리형(detached) CMS SignedData 를 만든다.
 * timestamp 를 주면 서명값에 RFC 3161 타임스탬프를 받아 비서명 속성으로 붙인다 (PAdES B-T).
 * @param {{ content: Buffer, keyPem: string, certPem: string, chainPems?: string[],
 *           timestamp?: (signature: Buffer) => Promise<Buffer|null> }} p
 */
async function buildCms({ content, keyPem, certPem, chainPems = [], timestamp }) {
  const certDer = new crypto.X509Certificate(certPem).raw;
  const chainDers = chainPems.map((p) => new crypto.X509Certificate(p).raw);
  const { issuer, serial } = issuerAndSerial(certDer);

  const attr = (type, value) => seq([oid(type), set([value])]);
  const signedAttrs = derSorted([
    attr(OID.contentType, oid(OID.data)),
    attr(OID.messageDigest, octet(sha256(content))),
    attr(OID.signingCertificateV2, signingCertificateV2(certDer)),
  ]);

  // 서명 대상은 [0] 태그가 아니라 SET 태그로 인코딩한 서명 속성 (RFC 5652 5.4)
  const signature = crypto.sign('sha256', der(set(signedAttrs)), keyPem);
  const token = timestamp ? await timestamp(signature) : null;

  const signerInfo = seq([
    int(1),
    seq([issuer, serial]),
    seq([oid(OID.sha256)]),
    ctx(0, signedAttrs),
    seq([oid(OID.rsaEncryption), nul()]),
    octet(signature),
    ...(token ? [ctx(1, [attr(OID.timeStampToken, fromDer(token))])] : []), // [1] IMPLICIT unsignedAttrs
  ]);
  const signedData = seq([
    int(1),
    set([seq([oid(OID.sha256)])]),
    seq([oid(OID.data)]), // 내용 없음 = detached
    ctx(0, [certDer, ...chainDers].map(fromDer)),
    set([signerInfo]),
  ]);
  return der(seq([oid(OID.signedData), ctx(0, [signedData])]));
}

/**
 * @signpdf/signpdf 에 넘기는 서명기.
 * tsa.url 이 있으면 타임스탬프를 받아 붙이고(B-T), 실패하면 타임스탬프 없이(B-B) 서명한다.
 * 결과는 tsa.onResult({ ok, url, genTime? , error? }) 로 알려 준다.
 */
class CadesSigner extends Signer {
  constructor(seal, { tsa } = {}) {
    super();
    this.seal = seal;
    this.tsa = tsa?.url ? tsa : null;
  }

  async sign(pdfBuffer) {
    const { tsa } = this;
    return buildCms({
      content: pdfBuffer,
      keyPem: this.seal.keyPem,
      certPem: this.seal.certPem,
      chainPems: this.seal.chainPems,
      timestamp: tsa && (async (signature) => {
        try {
          const { token, genTime } = await (tsa.request || requestTimestamp)(tsa.url, signature, { timeoutMs: tsa.timeoutMs });
          tsa.onResult?.({ ok: true, url: tsa.url, genTime: genTime.toISOString() });
          return token;
        } catch (err) {
          tsa.onResult?.({ ok: false, url: tsa.url, error: err.message });
          return null;
        }
      }),
    });
  }
}

// ───────────────────────── 검증 ─────────────────────────

/** /Contents 의 0 패딩을 떼고 실제 DER 길이만큼 자른다 */
function trimDer(buf) {
  if (buf[0] !== 0x30) throw new Error('서명 데이터가 DER 형식이 아닙니다.');
  const first = buf[1];
  if (first < 0x80) return buf.subarray(0, 2 + first);
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i += 1) len = len * 256 + buf[2 + i];
  return buf.subarray(0, 2 + n + len);
}

function decodePdfText(raw) {
  if (!raw) return null;
  if (raw.startsWith('<')) {
    const bytes = Buffer.from(raw.slice(1, -1).replace(/\s/g, ''), 'hex');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const le = Buffer.from(bytes.subarray(2));
      for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
      return le.toString('utf16le');
    }
    return bytes.toString('latin1');
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, '$1');
}

function parsePdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s || '');
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz = 'Z'] = m;
  const zone = tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5)}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 서명 사전(/M, /Reason, /SubFilter)을 서명 위치 주변에서 읽는다 (서명값 16진수 부분 제외) */
function readSignatureDict(text, br) {
  const around = text.slice(Math.max(0, br[1] - 3000), br[1]) + text.slice(br[2], br[2] + 3000);
  const pick = (re) => (re.exec(around) || [])[1];
  return {
    subFilter: pick(/\/SubFilter\s*\/([^\s/<>[\]()]+)/),
    signingTime: parsePdfDate(pick(/\/M\s*\((D:[^)]+)\)/)),
    reason: decodePdfText(pick(/\/Reason\s*(<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\))/)),
    name: decodePdfText(pick(/\/Name\s*(<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\))/)),
  };
}

// 검증은 로그인 없이(인터넷 터널로도) 쓰는 기능이라, 조작된 PDF 한 개로 서버를 오래 붙잡지 못하게 제한한다.
//  - 서명 개수: 실제 문서는 많아야 몇 개. 넘으면 검사하지 않고 거절
//  - 서명값 칸(/Contents) 크기: 이 서비스는 최대 24KB, 장기검증(LTV) 정보를 넣은 외부 서명도 수백 KB 안쪽
const MAX_PDF_SIGNATURES = 20;
const MAX_CONTENTS_HEX_CHARS = 2 * 1024 * 1024; // 서명값 1MB(16진수 2MB)

function verifyOne(pdf, text, br, trustedCas) {
  const result = {
    byteRange: br,
    coversWholeDocument: br[0] === 0 && br[2] + br[3] === pdf.length,
    integrity: false,
    signatureValid: false,
    trusted: false,
    certValidAtSigningTime: false,
    ...readSignatureDict(text, br),
    signer: null,
    errors: [],
  };
  try {
    if (br[1] < 0 || br[2] > pdf.length || br[2] + br[3] > pdf.length || br[1] >= br[2]) throw new Error('ByteRange가 파일 범위를 벗어납니다.');
    if (br[2] - br[1] - 2 > MAX_CONTENTS_HEX_CHARS) throw new Error('서명값 칸이 비정상적으로 큽니다.');
    const hex = pdf.subarray(br[1] + 1, br[2] - 1).toString('latin1').replace(/\s/g, '');
    const cms = trimDer(Buffer.from(hex, 'hex'));

    const contentInfo = fromDer(cms);
    if (oidOf(contentInfo.value[0]) !== OID.signedData) throw new Error('CMS SignedData가 아닙니다.');
    const sd = contentInfo.value[1].value[0];
    const certNodes = sd.value.find((n) => n.tagClass === CTX && n.type === 0)?.value || [];
    const certs = certNodes.map((n) => new crypto.X509Certificate(der(n)));
    const signerInfo = sd.value[sd.value.length - 1].value[0];

    const si = signerInfo.value;
    const digestOid = oidOf(si[2].value[0]);
    const hashName = HASH_BY_OID[digestOid];
    if (!hashName) throw new Error(`지원하지 않는 해시 알고리즘입니다 (${digestOid}).`);
    const attrsIndex = si.findIndex((n, i) => i > 2 && n.tagClass === CTX && n.type === 0);
    if (attrsIndex < 0) throw new Error('서명 속성(signedAttrs)이 없습니다.');
    const attrs = si[attrsIndex];
    const signature = Buffer.from(si[attrsIndex + 2].value, 'binary');

    const attrMap = new Map(attrs.value.map((a) => [oidOf(a.value[0]), a.value[1].value[0]]));
    const messageDigest = attrMap.get(OID.messageDigest);
    if (!messageDigest) throw new Error('messageDigest 속성이 없습니다.');
    // 서명값을 해석한 뒤에만 문서 해시를 계산한다 (가짜 서명에 큰 파일 해시를 반복하지 않도록, 복사 없이 두 구간을 이어서)
    const actualDigest = crypto.createHash(hashName)
      .update(pdf.subarray(br[0], br[0] + br[1]))
      .update(pdf.subarray(br[2], br[2] + br[3]))
      .digest();
    result.integrity = Buffer.from(messageDigest.value, 'binary').equals(actualDigest);
    if (!result.integrity) result.errors.push('서명 이후 문서 내용이 변경되었습니다.');
    result.hasSigningCertificateV2 = attrMap.has(OID.signingCertificateV2);

    // 서명 속성을 SET 태그로 다시 인코딩한 값에 대한 서명을, 포함된 인증서 중 맞는 것으로 검증
    const signedBytes = der(attrs);
    signedBytes[0] = 0x31;
    const signerCert = certs.find((c) => {
      try {
        return crypto.verify(hashName, signedBytes, c.publicKey, signature);
      } catch {
        return false;
      }
    });
    result.signatureValid = Boolean(signerCert);
    if (!signerCert) {
      result.errors.push('서명값이 포함된 인증서와 맞지 않습니다.');
      return result;
    }

    result.signer = {
      subject: cnOf(signerCert.subject),
      issuer: cnOf(signerCert.issuer),
      serialNumber: signerCert.serialNumber,
      fingerprint256: signerCert.fingerprint256,
      validFrom: new Date(signerCert.validFrom).toISOString(),
      validTo: new Date(signerCert.validTo).toISOString(),
    };
    // 비서명 속성 [1] 의 RFC 3161 타임스탬프 (PAdES B-T)
    const unsigned = si.find((n, i) => i > attrsIndex + 2 && n.tagClass === CTX && n.type === 1);
    const tsAttr = unsigned?.value.find((a) => oidOf(a.value[0]) === OID.timeStampToken);
    if (tsAttr) {
      result.timestamp = verifyTimestampToken(der(tsAttr.value[1].value[0]), signature, trustedCas);
      if (!result.timestamp.valid) result.errors.push(...result.timestamp.errors.map((e) => `타임스탬프: ${e}`));
    }

    // 서명 시각: 유효한 타임스탬프가 있으면 TSA 시각, 없으면 PDF에 적힌 시각(/M, 서명자가 주장한 값)
    const stamped = result.timestamp?.valid ? new Date(result.timestamp.genTime) : null;
    result.signingTimeSource = stamped ? 'timestamp' : 'claimed';
    const at = stamped || result.signingTime || new Date();
    result.certValidAtSigningTime = at >= new Date(signerCert.validFrom) && at <= new Date(signerCert.validTo);
    if (!result.certValidAtSigningTime) result.errors.push('서명 시점에 인증서 유효기간이 아니었습니다.');
    result.trusted = chainIsTrusted(signerCert, certs, trustedCas);
    if (!result.trusted) result.errors.push('신뢰할 수 있는 인증기관이 발급한 인증서가 아닙니다.');
  } catch (err) {
    result.errors.push(`서명을 해석할 수 없습니다: ${err.message}`);
  }
  return result;
}

/**
 * PDF 안의 모든 전자서명을 검증한다.
 * @param {Buffer} pdf
 * @param {string[]} trustedCaPems 신뢰하는 루트 인증서들
 */
function verifyPdfSignatures(pdf, trustedCaPems = []) {
  const text = pdf.toString('latin1');
  const trustedCas = trustedCaPems.map((p) => new crypto.X509Certificate(p));
  // 같은 범위는 한 번만, 개수가 넘치면 그 자리에서 멈추고 거절 (전부 모아 두지 않음)
  const ranges = new Map();
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const br = m.slice(1, 5).map(Number);
    ranges.set(br.join(' '), br);
    if (ranges.size > MAX_PDF_SIGNATURES) {
      const err = new Error(`전자서명이 너무 많은 PDF입니다. (${MAX_PDF_SIGNATURES}개까지 검사)`);
      err.code = 'too_many_signatures';
      throw err;
    }
  }
  const signatures = [...ranges.values()].map((br) => verifyOne(pdf, text, br, trustedCas));
  const last = signatures[signatures.length - 1];
  return {
    signed: signatures.length > 0,
    // 마지막 서명이 파일 끝까지 덮고, 모든 서명이 유효해야 "변경 없음"
    valid: signatures.length > 0
      && signatures.every((s) => s.integrity && s.signatureValid)
      && last.coversWholeDocument,
    trusted: signatures.length > 0 && signatures.every((s) => s.trusted && s.certValidAtSigningTime),
    // 모든 서명에 유효한 타임스탬프가 있음 (PAdES B-T)
    timestamped: signatures.length > 0 && signatures.every((s) => s.timestamp?.valid),
    modifiedAfterSigning: signatures.length > 0 && !last.coversWholeDocument,
    signatures,
  };
}

module.exports = { CadesSigner, buildCms, verifyPdfSignatures, MAX_PDF_SIGNATURES };
