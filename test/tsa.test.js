'use strict';
// RFC 3161 타임스탬프 (PAdES B-T)
//  - 가짜 TSA로 요청·검증, 거절·오류 처리
//  - 봉인 PDF에 타임스탬프가 붙고 검증되는지 (+ OpenSSL ts -verify 독립 검증)
//  - TSA가 죽어 있어도 서명은 끝나고(B-B) 기록이 남는지
//  - 서버 설정 → 서명 완료 → 문서 기록·검증 API
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { startFakeTsa } = require('./fake-tsa');
const { requestTimestamp, verifyTimestampToken, parseGeneralizedTime } = require('../lib/tsa');
const { verifyPdfSignatures } = require('../lib/cades');
const { sealPdf } = require('../lib/finalize');
const { loadOrCreateSeal } = require('../lib/seal-cert');
const { createApp } = require('../server');

let tsa;
let tmp;
let seal;
const X509 = (pem) => new crypto.X509Certificate(pem);

/** 닫혀 있는 포트 = 연결 거부되는 TSA 주소 */
async function deadUrl() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}/tsa`;
}

async function onePagePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText('timestamp test', { x: 50, y: 780 });
  return { pdf, page };
}

test.before(async () => {
  tsa = await startFakeTsa();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-tsa-'));
  seal = loadOrCreateSeal(path.join(tmp, 'keys'));
});

test.after(async () => {
  await tsa.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GeneralizedTime 해석 (소수 초 포함)', () => {
  assert.equal(parseGeneralizedTime('20261109130947Z').toISOString(), '2026-11-09T13:09:47.000Z');
  assert.equal(parseGeneralizedTime('20261109130947.25Z').toISOString(), '2026-11-09T13:09:47.250Z');
  assert.throws(() => parseGeneralizedTime('2026-11-09'));
});

test('가짜 TSA: 요청 → 토큰 검증, 다른 데이터·신뢰 안 된 루트 구분', async () => {
  tsa.setMode('ok');
  const data = crypto.randomBytes(256);
  const before = Date.now();
  const { token, genTime } = await requestTimestamp(tsa.url, data);
  assert.ok(Math.abs(genTime.getTime() - before) < 5000, 'TSA 시각');

  const ok = verifyTimestampToken(token, data, [X509(tsa.caPem)]);
  assert.equal(ok.valid, true, ok.errors.join());
  assert.equal(ok.trusted, true);
  assert.equal(ok.tsa, 'Test TSA Responder');
  assert.deepEqual(ok.errors, []);

  const untrusted = verifyTimestampToken(token, data, []);
  assert.equal(untrusted.valid, true, '서명 자체는 유효');
  assert.equal(untrusted.trusted, false, '시험용 루트는 공인 루트 목록에 없음');

  const other = Buffer.from(data);
  other[0] ^= 1;
  const wrong = verifyTimestampToken(token, other, [X509(tsa.caPem)]);
  assert.equal(wrong.valid, false);
  assert.equal(wrong.imprintMatches, false);

  const broken = Buffer.from(token);
  broken[broken.length - 20] ^= 0xff; // 토큰 서명값 손상
  assert.equal(verifyTimestampToken(broken, data, [X509(tsa.caPem)]).valid, false);
});

test('가짜 TSA: 거절·nonce 불일치·HTTP 오류·이상한 응답·연결 실패는 오류', async () => {
  const data = crypto.randomBytes(32);
  for (const [mode, re] of [['reject', /거절/], ['wrong-nonce', /nonce/], ['http-error', /HTTP 500/], ['garbage', /해석할 수 없습니다/]]) {
    tsa.setMode(mode);
    await assert.rejects(requestTimestamp(tsa.url, data), re, mode);
  }
  tsa.setMode('ok');
  await assert.rejects(requestTimestamp(await deadUrl(), data), /연결할 수 없습니다/);
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('OpenSSL ts -verify 로 토큰 독립 검증', { skip: !hasOpenssl && 'openssl 없음' }, async () => {
  tsa.setMode('ok');
  const data = crypto.randomBytes(128);
  const { token } = await requestTimestamp(tsa.url, data);
  const dir = fs.mkdtempSync(path.join(tmp, 'ossl-'));
  fs.writeFileSync(path.join(dir, 'data.bin'), data);
  fs.writeFileSync(path.join(dir, 'token.der'), token);
  fs.writeFileSync(path.join(dir, 'ca.pem'), tsa.caPem);
  const run = (file) => spawnSync('openssl', ['ts', '-verify', '-data', file, '-in', path.join(dir, 'token.der'), '-token_in',
    '-CAfile', path.join(dir, 'ca.pem')], { encoding: 'utf8' });
  const ok = run(path.join(dir, 'data.bin'));
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /Verification: OK/);

  const other = Buffer.from(data);
  other[5] ^= 1;
  fs.writeFileSync(path.join(dir, 'other.bin'), other);
  assert.notEqual(run(path.join(dir, 'other.bin')).status, 0, '다른 데이터는 OpenSSL에서도 실패');
});

test('봉인 PDF에 타임스탬프가 붙고(B-T) 검증된다', async () => {
  tsa.setMode('ok');
  const { pdf, page } = await onePagePdf();
  const results = [];
  const out = await sealPdf(pdf, seal, { page, reason: 'test', tsa: { url: tsa.url, onResult: (r) => results.push(r) } });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);

  const v = verifyPdfSignatures(Buffer.from(out), [...seal.trustedCaPems, tsa.caPem]);
  assert.equal(v.valid, true);
  assert.equal(v.trusted, true);
  assert.equal(v.timestamped, true);
  const [s] = v.signatures;
  assert.equal(s.timestamp.valid, true, s.timestamp.errors.join());
  assert.equal(s.timestamp.trusted, true);
  assert.equal(s.signingTimeSource, 'timestamp');
  assert.equal(s.timestamp.genTime, results[0].genTime);
  assert.deepEqual(s.errors, []);

  // TSA 루트를 신뢰 목록에 넣지 않으면: 타임스탬프 자체는 유효, 신뢰만 안 됨 (봉인 서명은 그대로 유효)
  const v2 = verifyPdfSignatures(Buffer.from(out), seal.trustedCaPems);
  assert.equal(v2.valid, true);
  assert.equal(v2.signatures[0].timestamp.valid, true);
  assert.equal(v2.signatures[0].timestamp.trusted, false);
});

test('TSA가 응답하지 않아도 봉인은 완료(B-B)되고 실패가 보고된다', async () => {
  const { pdf, page } = await onePagePdf();
  const results = [];
  const url = await deadUrl();
  const out = await sealPdf(pdf, seal, { page, reason: 'test', tsa: { url, onResult: (r) => results.push(r) } });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /연결할 수 없습니다/);
  const v = verifyPdfSignatures(Buffer.from(out), seal.trustedCaPems);
  assert.equal(v.valid, true);
  assert.equal(v.trusted, true);
  assert.equal(v.timestamped, false);
  assert.equal(v.signatures[0].timestamp, undefined);
  assert.equal(v.signatures[0].signingTimeSource, 'claimed');
});

test('서버: 설정에서 TSA를 켜면 서명 완료 PDF가 B-T로 봉인되고 기록이 남는다', async () => {
  const dataDir = path.join(tmp, 'app');
  const server = createApp({ dataDir, adminPassword: 'tsa-test-password' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = (url, { method = 'GET', body } = {}) => fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const post = (url, body) => call(url, { method: 'POST', body });
  try {
    cookie = (await post('/api/auth/login', { password: 'tsa-test-password' })).headers.get('set-cookie').split(';')[0];

    const initial = await (await call('/api/settings')).json();
    assert.equal(initial.tsa.enabled, false, '기본은 꺼짐');
    assert.equal(initial.tsa.url, 'http://timestamp.digicert.com', '추천 주소가 미리 채워짐');

    assert.equal((await post('/api/settings', { tsa: { enabled: true, url: 'ftp://x' } })).status, 400, 'http(s)만');
    assert.equal((await post('/api/settings', { tsa: { enabled: true, url: '' } })).status, 400, '켜려면 주소 필요');
    const saved = await (await post('/api/settings', { tsa: { enabled: true, url: tsa.url } })).json();
    assert.equal(saved.tsa.enabled, true);

    tsa.setMode('ok');
    const tested = await post('/api/settings/test-tsa', { url: tsa.url });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).tsa, 'Test TSA Responder');
    assert.equal((await post('/api/settings/test-tsa', { url: await deadUrl() })).status, 502);

    const { pdf } = await onePagePdf();
    const signAndFinish = async (title) => {
      const doc = await (await post('/api/documents', {
        title,
        fileName: 'a.pdf',
        pdfBase64: Buffer.from(await pdf.save()).toString('base64'),
        signers: [{ name: '홍길동' }],
        fields: [{ signerIndex: 0, page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 }],
      })).json();
      const t = new URL(doc.signers[0].signPath, base).searchParams.get('t');
      const view = await (await call(`/api/sign/${t}`)).json();
      const sig = Object.fromEntries(view.fields.map((f) => [f.id, PNG]));
      const done = await post(`/api/sign/${t}`, { consent: true, signatures: sig });
      assert.equal(done.status, 200, await done.clone().text());
      return (await call(`/api/documents/${doc.id}`)).json();
    };

    const stamped = await signAndFinish('타임스탬프 문서');
    assert.equal(stamped.seal.format, 'PAdES-B-T');
    assert.ok(stamped.seal.timestamp.genTime);
    assert.deepEqual(stamped.events.map((e) => e.type).slice(-2), ['completed', 'timestamped']);
    const file = Buffer.from(await (await call(`/api/documents/${stamped.id}/completed.pdf`)).arrayBuffer());
    const v = await (await post('/api/verify-signature', { pdfBase64: file.toString('base64') })).json();
    assert.equal(v.valid, true);
    assert.equal(v.timestamped, true);
    assert.equal(v.signatures[0].timestamp.tsa, 'Test TSA Responder');

    // TSA 장애: 서명은 끝나고 B-B + 실패 기록
    tsa.setMode('http-error');
    const fallback = await signAndFinish('타임스탬프 실패 문서');
    assert.equal(fallback.status, 'completed');
    assert.equal(fallback.seal.format, 'PAdES-B-B');
    const last = fallback.events[fallback.events.length - 1];
    assert.equal(last.type, 'timestamp_failed');
    assert.match(last.detail, /HTTP 500/);
  } finally {
    tsa.setMode('ok');
    server.close();
  }
});

/** 단색 PNG (서명 이미지 대용) */
const PNG = (() => {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(20 * 4, Buffer.from([20, 40, 160, 255]))]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
})();
