'use strict';
// 공개 서명 검증(/api/verify-signature)이 조작된 PDF 한 개로 서버를 오래 멈추지 않는지
//  - /ByteRange 를 수천 개 넣은 PDF → 개수 제한으로 바로 거절
//  - 서명값 칸(/Contents)을 비정상적으로 크게 잡은 서명 → 무거운 처리 없이 오류로 표시
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { verifyPdfSignatures, MAX_PDF_SIGNATURES } = require('../lib/cades');

const SIZE = 15 * 1024 * 1024;

/** 공백으로 채운 큰 PDF에 /ByteRange 항목을 여러 개 넣는다 */
function craftedPdf(ranges) {
  const body = Buffer.alloc(SIZE, 0x20);
  Buffer.from('%PDF-1.7\n').copy(body, 0);
  let at = 16;
  for (const br of ranges) {
    const unit = Buffer.from(`/ByteRange [${br.join(' ')}]\n`, 'latin1');
    unit.copy(body, at);
    at += unit.length;
  }
  return body;
}

test('/ByteRange가 너무 많은 PDF는 검사하지 않고 바로 거절', () => {
  // 범위를 조금씩 바꿔 중복 제거로도 걸러지지 않게 한다
  const pdf = craftedPdf(Array.from({ length: 2000 }, (_, i) => [0, 1 + i, SIZE - 2, 1]));
  const started = Date.now();
  assert.throws(() => verifyPdfSignatures(pdf, []), (err) => err.code === 'too_many_signatures');
  assert.ok(Date.now() - started < 3000, `거절까지 ${Date.now() - started}ms`);
});

test('같은 /ByteRange가 반복되면 한 번만 검사', () => {
  const pdf = craftedPdf(Array.from({ length: 500 }, () => [0, 100, 200, 50]));
  const r = verifyPdfSignatures(pdf, []);
  assert.equal(r.signatures.length, 1);
});

test('서명 최대 개수까지는 그대로 검사', () => {
  const pdf = craftedPdf(Array.from({ length: MAX_PDF_SIGNATURES }, (_, i) => [0, 100 + i, 200 + i, 50]));
  const r = verifyPdfSignatures(pdf, []);
  assert.equal(r.signatures.length, MAX_PDF_SIGNATURES);
  assert.equal(r.valid, false);
});

test('서명값 칸이 비정상적으로 큰 서명은 해석하지 않고 오류로 표시', () => {
  const pdf = craftedPdf([[0, 1, SIZE - 2, 1]]);
  const started = Date.now();
  const r = verifyPdfSignatures(pdf, []);
  assert.ok(Date.now() - started < 1000, `검사 ${Date.now() - started}ms`);
  assert.equal(r.valid, false);
  assert.match(r.signatures[0].errors.join(' '), /서명값/);
});

test('API: 조작된 PDF는 400으로 바로 거절되고 서버는 계속 응답', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-verify-'));
  const server = createApp({ dataDir, reminderIntervalMs: 0 }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const pdf = craftedPdf(Array.from({ length: 2000 }, (_, i) => [0, 1 + i, SIZE - 2, 1]));
    const started = Date.now();
    const res = await fetch(`${url}/api/verify-signature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: pdf.toString('base64') }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /전자서명이 너무 많/);
    assert.ok(Date.now() - started < 5000, `응답까지 ${Date.now() - started}ms`);
    assert.equal((await fetch(`${url}/api/seal`)).status, 200, '다른 요청도 정상 처리');
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
