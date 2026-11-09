'use strict';
// RFC 3161 타임스탬프: TSA(시점 확인 기관)에 서명값의 해시를 보내 "이 시각에 존재했음" 토큰을 받고, 검증한다.
// PAdES B-T = B-B 서명의 SignerInfo 비서명 속성(id-aa-timeStampToken)에 이 토큰을 넣은 것.
const crypto = require('crypto');
const tls = require('tls');
const {
  U, CTX, T, OID, HASH_BY_OID,
  oid, seq, octet, int, bigInt, bool, nul, der, fromDer, oidOf, bytesOf,
  readTlv, verifySignedBytes, chainIsTrusted, cnOf,
} = require('./asn1');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** 추천 무료 TSA (설정 화면 기본값) */
const DEFAULT_TSA_URL = 'http://timestamp.digicert.com';

/** TimeStampReq { version 1, messageImprint(SHA-256), nonce, certReq TRUE } */
function buildTimestampRequest(data, nonce = crypto.randomBytes(8)) {
  const hash = crypto.createHash('sha256').update(data).digest();
  return der(seq([
    int(1),
    seq([seq([oid(OID.sha256), nul()]), octet(hash)]),
    bigInt(nonce),
    bool(true),
  ]));
}

const PKI_STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];

/**
 * TSA에 타임스탬프를 요청한다. 성공하면 TimeStampToken(ContentInfo) DER 바이트를 돌려준다.
 * @param {string} url
 * @param {Buffer} data 타임스탬프를 찍을 데이터 (PAdES에서는 서명값)
 */
async function requestTimestamp(url, data, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const nonce = crypto.randomBytes(8);
  nonce[0] &= 0x7f;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
      body: buildTimestampRequest(data, nonce),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `TSA 응답 시간 초과 (${timeoutMs / 1000}초)` : `TSA에 연결할 수 없습니다 (${err.cause?.code || err.message})`);
  }
  if (!res.ok) throw new Error(`TSA가 오류를 돌려주었습니다 (HTTP ${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('TSA 응답이 너무 큽니다.');

  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
  // 토큰은 다시 인코딩하지 않고 원래 바이트를 그대로 잘라 쓴다.
  let token;
  let statusNode;
  try {
    const outer = readTlv(body, 0);
    const status = readTlv(body, outer.contentStart);
    statusNode = fromDer(body.subarray(status.start, status.end));
    if (status.end < outer.end) {
      const tok = readTlv(body, status.end);
      token = body.subarray(tok.start, tok.end);
    }
  } catch (err) {
    throw new Error(`TSA 응답을 해석할 수 없습니다: ${err.message}`);
  }
  const code = Number.parseInt(bytesOf(statusNode.value[0]).toString('hex') || '0', 16);
  if (code > 1 || !token) throw new Error(`TSA가 요청을 거절했습니다 (${PKI_STATUS[code] || code})`);

  const info = parseTimestampToken(token);
  const expected = crypto.createHash(info.hashName).update(data).digest();
  if (!info.imprint.equals(expected)) throw new Error('TSA 응답의 해시가 요청과 다릅니다.');
  if (!info.nonce || !info.nonce.equals(stripLeadingZero(nonce))) throw new Error('TSA 응답의 nonce가 요청과 다릅니다.');
  return { token, genTime: info.genTime };
}

const stripLeadingZero = (buf) => {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  return buf.subarray(i);
};

/** GeneralizedTime "YYYYMMDDHHMMSS[.fff]Z" → Date */
function parseGeneralizedTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
  if (!m) throw new Error(`시각 형식을 해석할 수 없습니다 (${s})`);
  const [, y, mo, d, h, mi, se, frac = ''] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${frac.slice(0, 4)}Z`);
}

/** TimeStampToken(ContentInfo → SignedData → TSTInfo) 을 해석한다 */
function parseTimestampToken(tokenDer) {
  const contentInfo = fromDer(tokenDer);
  if (oidOf(contentInfo.value[0]) !== OID.signedData) throw new Error('타임스탬프 토큰이 CMS SignedData가 아닙니다.');
  const sd = contentInfo.value[1].value[0];
  const encap = sd.value[2];
  if (oidOf(encap.value[0]) !== OID.tstInfo) throw new Error('타임스탬프 토큰에 TSTInfo가 없습니다.');
  const tstInfoDer = bytesOf(encap.value[1].value[0]);
  const tst = fromDer(tstInfoDer).value;

  const imprint = tst[2];
  const hashName = HASH_BY_OID[oidOf(imprint.value[0].value[0])];
  if (!hashName) throw new Error('타임스탬프 토큰의 해시 알고리즘을 지원하지 않습니다.');
  const genTime = parseGeneralizedTime(tst[4].value);
  // genTime 뒤: accuracy(SEQUENCE)? ordering(BOOLEAN)? nonce(INTEGER)? tsa[0]? extensions[1]?
  const rest = tst.slice(5);
  const nonceNode = rest.find((n) => n.tagClass === U && n.type === T.INTEGER);

  const certNodes = sd.value.find((n) => n.tagClass === CTX && n.type === 0)?.value || [];
  return {
    hashName,
    imprint: bytesOf(imprint.value[1]),
    serialNumber: bytesOf(tst[3]).toString('hex'),
    policy: oidOf(tst[1]),
    genTime,
    nonce: nonceNode ? stripLeadingZero(bytesOf(nonceNode)) : null,
    tstInfoDer,
    certs: certNodes.map((n) => new crypto.X509Certificate(der(n))),
    signerInfo: sd.value[sd.value.length - 1].value[0],
  };
}

let systemRoots;
/** Node에 내장된 공인 루트 인증서 (Mozilla 목록) — 공용 TSA 인증서 체인 확인용 */
function systemRootCas() {
  systemRoots ||= tls.rootCertificates.flatMap((pem) => {
    try {
      return [new crypto.X509Certificate(pem)];
    } catch {
      return [];
    }
  });
  return systemRoots;
}

/**
 * 타임스탬프 토큰을 검증한다.
 * @param {Buffer} tokenDer
 * @param {Buffer} data 타임스탬프가 찍혀야 하는 데이터 (서명값)
 * @param {import('crypto').X509Certificate[]} trustedCas 추가로 신뢰할 루트 (내장 공인 루트는 항상 포함)
 */
function verifyTimestampToken(tokenDer, data, trustedCas = []) {
  const result = { valid: false, imprintMatches: false, signatureValid: false, trusted: false, genTime: null, tsa: null, errors: [] };
  try {
    const info = parseTimestampToken(tokenDer);
    result.genTime = info.genTime.toISOString();
    result.serialNumber = info.serialNumber;
    result.imprintMatches = info.imprint.equals(crypto.createHash(info.hashName).update(data).digest());
    if (!result.imprintMatches) result.errors.push('타임스탬프가 이 서명값에 찍힌 것이 아닙니다.');

    const si = info.signerInfo.value;
    const hashName = HASH_BY_OID[oidOf(si[2].value[0])];
    if (!hashName) throw new Error('타임스탬프 서명의 해시 알고리즘을 지원하지 않습니다.');
    const attrsIndex = si.findIndex((n, i) => i > 2 && n.tagClass === CTX && n.type === 0);
    if (attrsIndex < 0) throw new Error('타임스탬프 서명 속성이 없습니다.');
    const attrs = si[attrsIndex];
    const attrMap = new Map(attrs.value.map((a) => [oidOf(a.value[0]), a.value[1].value[0]]));
    const digest = attrMap.get(OID.messageDigest);
    const contentType = attrMap.get(OID.contentType);
    const digestOk = Boolean(digest) && bytesOf(digest).equals(crypto.createHash(hashName).update(info.tstInfoDer).digest());
    if (!digestOk || !contentType || oidOf(contentType) !== OID.tstInfo) throw new Error('타임스탬프 내용(TSTInfo)이 서명과 맞지 않습니다.');

    const signedBytes = der(attrs);
    signedBytes[0] = 0x31; // [0] → SET 태그로 바꿔 서명 대상 복원
    const signature = bytesOf(si[attrsIndex + 2]);
    const tsaCert = info.certs.find((c) => verifySignedBytes(hashName, signedBytes, c, signature));
    result.signatureValid = Boolean(tsaCert);
    if (!tsaCert) {
      result.errors.push('타임스탬프 서명값이 포함된 TSA 인증서와 맞지 않습니다.');
      return result;
    }
    result.tsa = cnOf(tsaCert.subject);
    const ekuOk = (tsaCert.keyUsage || []).includes(OID.ekuTimeStamping);
    if (!ekuOk) result.errors.push('TSA 인증서에 타임스탬프 용도(timeStamping)가 없습니다.');
    const inValidity = info.genTime >= new Date(tsaCert.validFrom) && info.genTime <= new Date(tsaCert.validTo);
    if (!inValidity) result.errors.push('타임스탬프 시각에 TSA 인증서 유효기간이 아니었습니다.');
    result.trusted = chainIsTrusted(tsaCert, info.certs, [...trustedCas, ...systemRootCas()]);
    if (!result.trusted) result.errors.push('TSA 인증서를 신뢰할 수 없습니다 (공인 루트에 연결되지 않음).');
    result.valid = result.imprintMatches && result.signatureValid && ekuOk && inValidity;
  } catch (err) {
    result.errors.push(`타임스탬프를 해석할 수 없습니다: ${err.message}`);
  }
  return result;
}

module.exports = {
  DEFAULT_TSA_URL, buildTimestampRequest, requestTimestamp, parseTimestampToken, verifyTimestampToken, parseGeneralizedTime,
};
