'use strict';
// 테스트용 가짜 TSA(RFC 3161 타임스탬프 서버). 자체 루트 CA + timeStamping 용도의 TSA 인증서로 토큰을 서명한다.
//   mode: 'ok' | 'reject'(거절 응답) | 'wrong-nonce' | 'http-error' | 'garbage'
const crypto = require('crypto');
const http = require('http');
const forge = require('node-forge');
const {
  asn1, U, T, OID, oid, seq, set, octet, int, bigInt, ctx, der, fromDer,
  derSorted, signingCertificateV2,
} = require('../lib/asn1');

function makeCert({ cn, key, issuerCert, issuerKey, ca, extensions }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = key.publicKey;
  cert.serialNumber = `01${crypto.randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600e3);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer((issuerCert || cert).subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: ca, critical: true }, ...extensions]);
  cert.sign(issuerKey || key.privateKey, forge.md.sha256.create());
  return cert;
}

const certDer = (cert) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');

function createTsaIdentity() {
  const caKey = forge.pki.rsa.generateKeyPair(2048);
  const caCert = makeCert({ cn: 'Test TSA Root', key: caKey, ca: true, extensions: [{ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }] });
  const tsaKey = forge.pki.rsa.generateKeyPair(2048);
  const tsaCert = makeCert({
    cn: 'Test TSA Responder',
    key: tsaKey,
    issuerCert: caCert,
    issuerKey: caKey.privateKey,
    ca: false,
    extensions: [
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', timeStamping: true, critical: true }, // RFC 3161: 반드시 critical
    ],
  });
  return {
    caPem: forge.pki.certificateToPem(caCert),
    caDer: certDer(caCert),
    tsaDer: certDer(tsaCert),
    tsaKeyPem: forge.pki.privateKeyToPem(tsaKey.privateKey),
  };
}

const generalizedTime = (d) => asn1.create(U, T.GENERALIZEDTIME, false, `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`);

/** TimeStampReq → TimeStampResp DER */
function respond(id, reqDer, mode) {
  if (mode === 'reject') return der(seq([seq([int(2)])]));
  const req = fromDer(reqDer).value;
  const imprint = req[1];
  let nonce = req.find((n, i) => i > 1 && n.tagClass === U && n.type === T.INTEGER);
  if (mode === 'wrong-nonce') nonce = bigInt(crypto.randomBytes(8));

  const tstInfoDer = der(seq([
    int(1),
    oid('1.3.6.1.4.1.99999.1'), // 시험용 정책
    imprint,
    bigInt(crypto.randomBytes(8)),
    generalizedTime(new Date()),
    ...(nonce ? [nonce] : []),
  ]));
  const attr = (type, value) => seq([oid(type), set([value])]);
  const signedAttrs = derSorted([
    attr(OID.contentType, oid(OID.tstInfo)),
    attr(OID.messageDigest, octet(crypto.createHash('sha256').update(tstInfoDer).digest())),
    attr(OID.signingCertificateV2, signingCertificateV2(id.tsaDer)),
  ]);
  const signature = crypto.sign('sha256', der(set(signedAttrs)), id.tsaKeyPem);
  const tbs = fromDer(id.tsaDer).value[0];
  const signerInfo = seq([
    int(1),
    seq([tbs.value[3], tbs.value[1]]), // issuer, serial ([0] version 다음)
    seq([oid(OID.sha256)]),
    ctx(0, signedAttrs),
    seq([oid(OID.rsaEncryption), asn1.create(U, T.NULL, false, '')]),
    octet(signature),
  ]);
  const token = seq([oid(OID.signedData), ctx(0, [seq([
    int(3),
    set([seq([oid(OID.sha256)])]),
    seq([oid(OID.tstInfo), ctx(0, [octet(tstInfoDer)])]),
    ctx(0, [fromDer(id.tsaDer), fromDer(id.caDer)]),
    set([signerInfo]),
  ])])]);
  return der(seq([seq([int(0)]), token]));
}

/** 가짜 TSA HTTP 서버를 띄운다 */
async function startFakeTsa() {
  const id = createTsaIdentity();
  const state = { mode: 'ok', requests: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.requests += 1;
      if (state.mode === 'http-error') return res.writeHead(500).end();
      if (state.mode === 'garbage') return res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }).end('not asn1');
      if (req.headers['content-type'] !== 'application/timestamp-query') return res.writeHead(415).end();
      return res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }).end(respond(id, Buffer.concat(chunks), state.mode));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/tsa`,
    caPem: id.caPem,
    get requests() { return state.requests; },
    setMode(m) { state.mode = m; },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startFakeTsa };
