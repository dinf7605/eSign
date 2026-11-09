'use strict';
// 서비스의 "문서 봉인" 인증서를 준비한다.
//  - 기본: 처음 실행할 때 자체 루트 CA + 봉인용 인증서를 만들어 data/keys/에 저장
//  - 실제 운영: 공인 문서서명 인증서가 있으면 환경변수로 지정
//      ESIGN_SEAL_KEY   봉인 개인키 PEM 경로
//      ESIGN_SEAL_CERT  봉인 인증서 PEM 경로
//      ESIGN_SEAL_CHAIN 중간/루트 인증서 PEM 묶음 경로 (선택)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const UTF8 = forge.asn1.Type.UTF8;
const DOCUMENT_SIGNING_EKU = '1.3.6.1.4.1.311.10.3.12'; // Microsoft Document Signing (Adobe도 인식)

function splitPems(text) {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01; // 양수 + 앞자리 0 아님
  return bytes.toString('hex');
}

function newRsaKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  return { pem, forgeKey: forge.pki.privateKeyFromPem(pem) };
}

function forgePublicKey(forgePrivateKey) {
  return forge.pki.setRsaPublicKey(forgePrivateKey.n, forgePrivateKey.e);
}

function makeCert({ subject, issuerCert, issuerKey, publicKey, years, extensions }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 24 * 3600 * 1000);
  cert.setSubject(subject);
  cert.setIssuer(issuerCert ? issuerCert.subject.attributes : subject);
  cert.setExtensions(extensions);
  cert.sign(issuerKey, forge.md.sha256.create());
  return cert;
}

function generateSelfIssued(dir) {
  const org = { shortName: 'O', value: 'e서명 (자체 발급)', valueTagClass: UTF8 };
  const country = { shortName: 'C', value: 'KR' };

  const caKey = newRsaKey();
  const caPub = forgePublicKey(caKey.forgeKey);
  const caCert = makeCert({
    subject: [country, org, { shortName: 'CN', value: 'e서명 루트 CA', valueTagClass: UTF8 }],
    issuerKey: caKey.forgeKey,
    publicKey: caPub,
    years: 10,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ],
  });

  const sealKey = newRsaKey();
  const sealCert = makeCert({
    subject: [country, org, { shortName: 'CN', value: 'e서명 문서 봉인', valueTagClass: UTF8 }],
    issuerCert: caCert,
    issuerKey: caKey.forgeKey,
    publicKey: forgePublicKey(sealKey.forgeKey),
    years: 3,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
      { name: 'extKeyUsage', emailProtection: true, [DOCUMENT_SIGNING_EKU]: true },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), data, { mode: 0o600 });
  write('ca.key.pem', caKey.pem); // 새 봉인 인증서를 다시 발급할 때만 필요 — 운영에서는 오프라인 보관
  write('ca.crt.pem', forge.pki.certificateToPem(caCert));
  write('seal.key.pem', sealKey.pem);
  write('seal.crt.pem', forge.pki.certificateToPem(sealCert));
}

function describe(certPem) {
  const x = new crypto.X509Certificate(certPem);
  const cn = (dn) => (/CN=([^\n]+)/.exec(dn) || [])[1] || dn;
  return {
    subject: cn(x.subject),
    issuer: cn(x.issuer),
    serialNumber: x.serialNumber,
    fingerprint256: x.fingerprint256,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
  };
}

/**
 * @returns {{ keyPem: string, certPem: string, chainPems: string[], trustedCaPems: string[], info: object, selfIssued: boolean }}
 */
function loadOrCreateSeal(dir) {
  let keyPem;
  let certPem;
  let chainPems;
  let selfIssued = false;

  if (process.env.ESIGN_SEAL_KEY && process.env.ESIGN_SEAL_CERT) {
    keyPem = fs.readFileSync(process.env.ESIGN_SEAL_KEY, 'utf8');
    certPem = splitPems(fs.readFileSync(process.env.ESIGN_SEAL_CERT, 'utf8'))[0];
    chainPems = process.env.ESIGN_SEAL_CHAIN ? splitPems(fs.readFileSync(process.env.ESIGN_SEAL_CHAIN, 'utf8')) : [];
  } else {
    if (!fs.existsSync(path.join(dir, 'seal.crt.pem'))) generateSelfIssued(dir);
    keyPem = fs.readFileSync(path.join(dir, 'seal.key.pem'), 'utf8');
    certPem = fs.readFileSync(path.join(dir, 'seal.crt.pem'), 'utf8');
    chainPems = [fs.readFileSync(path.join(dir, 'ca.crt.pem'), 'utf8')];
    selfIssued = true;
  }

  // 키와 인증서가 짝이 맞는지 확인
  const cert = new crypto.X509Certificate(certPem);
  if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) {
    throw new Error('봉인 인증서와 개인키가 서로 맞지 않습니다.');
  }

  return {
    keyPem,
    certPem,
    chainPems,
    // 검증 시 "신뢰"로 인정할 루트: 체인의 마지막(자체 발급이면 우리 루트 CA)
    trustedCaPems: chainPems.length ? [chainPems[chainPems.length - 1]] : [],
    info: describe(certPem),
    selfIssued,
  };
}

module.exports = { loadOrCreateSeal, describe };
