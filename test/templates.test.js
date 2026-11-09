'use strict';
// 템플릿: 자주 쓰는 PDF + 칸 배치 저장 → 목록·불러오기 → 그대로 일괄 요청 만들기 → 이름 바꾸기·삭제
//  - 관리자 로그인 필요, 인터넷 공개 모드(터널)에서는 차단
//  - 템플릿을 지워도 이미 만든 요청은 그대로
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../server');

const PASSWORD = 'templates-test-pw';
let server;
let base;
let dataDir;
let cookie = '';

const call = (url, { method = 'GET', body, auth = true, headers = {} } = {}) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (url, body, opts) => call(url, { method: 'POST', body, ...opts });
const json = async (res) => ({ status: res.status, body: await res.json() });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let pdfBytes;
const SIG = { type: 'signature', page: 1, x: 0.6, y: 0.85, w: 0.25, h: 0.06 };
const AGREE = { type: 'checkbox', label: '개인정보 수집 동의', required: true, page: 2, x: 0.1, y: 0.2, w: 0.04, h: 0.03 };

test.before(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]);
  pdfBytes = Buffer.from(await pdf.save());
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-templates-'));
  server = createApp({ dataDir, adminPassword: PASSWORD }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await post('/api/auth/login', { password: PASSWORD })).headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('템플릿은 관리자만, 인터넷 공개 모드(터널)로는 차단', async () => {
  assert.equal((await call('/api/templates', { auth: false })).status, 401);
  const tunneled = await call('/api/templates', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(tunneled.status, 403);
});

test('입력 검사: 이름 필수, 서명란 필수, 서명자마다 서명란', async () => {
  const pdfBase64 = pdfBytes.toString('base64');
  const make = (body) => post('/api/templates', { name: '동의서', fileName: 'a.pdf', pdfBase64, fields: [SIG], ...body });
  assert.equal((await make({ name: '  ' })).status, 400, '이름 없음');
  assert.equal((await make({ name: 'x'.repeat(101) })).status, 400, '이름 100자 초과');
  assert.equal((await make({ fields: [AGREE] })).status, 400, '서명란 없음');
  assert.equal((await make({ fields: [{ ...SIG, page: 3 }] })).status, 400, '없는 쪽');
  assert.equal((await make({ pdfBase64: Buffer.from('hello').toString('base64') })).status, 400, 'PDF 아님');
  const multi = await make({ mode: 'multi', signerCount: 2, fields: [{ ...SIG, signerIndex: 0 }] });
  assert.equal(multi.status, 400, '2번 서명자 서명란 없음');
  assert.match((await multi.json()).error, /2번 서명자/);
  assert.equal((await make({ mode: 'multi', signerCount: 11, fields: [{ ...SIG, signerIndex: 0 }] })).status, 400, '서명자 수 초과');
});

test('저장 → 목록 → 불러오기(PDF·칸) → 그대로 일괄 요청 만들기', async () => {
  const saved = await json(await post('/api/templates', {
    name: '  2026 개인정보   동의서 ',
    fileName: '동의서.pdf',
    pdfBase64: pdfBytes.toString('base64'),
    info: '장소: 3층 강의실',
    requireVerification: false,
    fields: [SIG, AGREE],
  }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const t = saved.body;
  assert.equal(t.name, '2026 개인정보 동의서', '공백 정리');
  assert.equal(t.mode, 'group');
  assert.equal(t.pageCount, 2);
  assert.equal(t.requireVerification, false);
  assert.deepEqual(t.inputLabels, ['개인정보 수집 동의']);
  assert.equal(t.fields.length, 2);
  assert.equal(t.fields[0].signerIndex, undefined, '일괄 요청 템플릿은 서명자 번호 없음');

  const list = await (await call('/api/templates')).json();
  assert.equal(list[0].id, t.id, '최근 것이 맨 위');
  assert.equal(list[0].fields, undefined, '목록에는 칸 정보 생략');

  const full = await (await call(`/api/templates/${t.id}`)).json();
  assert.equal(full.info, '장소: 3층 강의실');
  assert.deepEqual(full.fields[1], { ...AGREE });
  const pdf = Buffer.from(await (await call(`/api/templates/${t.id}/document.pdf`)).arrayBuffer());
  assert.equal(sha256(pdf), sha256(pdfBytes), '저장한 PDF 그대로');

  // 화면이 하는 일: 템플릿 PDF와 칸으로 일괄 요청 만들기
  const group = await json(await post('/api/groups', {
    title: full.name,
    fileName: full.fileName,
    pdfBase64: pdf.toString('base64'),
    info: full.info,
    requireVerification: full.requireVerification,
    members: [{ name: '홍길동' }],
    fields: full.fields,
  }));
  assert.equal(group.status, 201, JSON.stringify(group.body));
});

test('한 문서 여러 명 템플릿: 서명자 번호 유지', async () => {
  const r = await json(await post('/api/templates', {
    name: '공동 계약서',
    mode: 'multi',
    signerCount: 2,
    fileName: 'c.pdf',
    pdfBase64: pdfBytes.toString('base64'),
    fields: [{ ...SIG, signerIndex: 0 }, { ...SIG, x: 0.1, signerIndex: 1 }],
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.signerCount, 2);
  assert.deepEqual(r.body.fields.map((f) => f.signerIndex), [0, 1]);
  assert.equal(r.body.info, '');
});

test('만든 일괄 요청을 템플릿으로 저장, 이름 바꾸기, 삭제해도 기존 요청은 그대로', async () => {
  const group = await json(await post('/api/groups', {
    title: '안전교육 서약서',
    fileName: '서약서.pdf',
    pdfBase64: pdfBytes.toString('base64'),
    info: '일시: 11/10',
    requireVerification: false,
    members: [{ name: '김교육' }],
    fields: [SIG, AGREE],
  }));
  assert.equal(group.status, 201);
  const fromGroup = await json(await post(`/api/groups/${group.body.id}/template`, {}));
  assert.equal(fromGroup.status, 201, JSON.stringify(fromGroup.body));
  assert.equal(fromGroup.body.name, '안전교육 서약서', '이름을 안 주면 교육명');
  assert.equal(fromGroup.body.info, '일시: 11/10');
  assert.deepEqual(fromGroup.body.inputLabels, ['개인정보 수집 동의']);
  assert.equal((await post('/api/groups/nope/template', {})).status, 404);

  const id = fromGroup.body.id;
  assert.equal((await post(`/api/templates/${id}`, { name: '' })).status, 400);
  const renamed = await json(await post(`/api/templates/${id}`, { name: '안전교육 서약서 (2기)' }));
  assert.equal(renamed.body.name, '안전교육 서약서 (2기)');
  assert.ok(renamed.body.updatedAt);

  const file = path.join(dataDir, 'files', `tpl-${id}.pdf`);
  assert.ok(fs.existsSync(file));
  assert.equal((await post(`/api/templates/${id}/delete`, {})).status, 200);
  assert.equal(fs.existsSync(file), false, 'PDF도 지움');
  assert.equal((await call(`/api/templates/${id}`)).status, 404);
  assert.equal((await post(`/api/templates/${id}/delete`, {})).status, 404);

  // 원래 요청의 문서는 그대로
  assert.equal((await call(`/api/groups/${group.body.id}/template.pdf`)).status, 200);
});
