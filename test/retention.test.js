'use strict';
// 보관 기간 · 삭제(파기)
//  - 직접 삭제: 확인 필요, db 기록과 파일(원본·서명 이미지·완료 PDF)이 모두 사라짐, 서명 링크·등록 대조도 끝
//  - 파기 기록에는 개인정보 없이 제목·인원·이유·시각만
//  - 보관 기간: 끝난 날(만든 날·기한·마지막 서명 중 늦은 날) + N개월이 지나면 자동 삭제, 30일 안 예정 목록
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../server');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'retention-test-pw';
const PNG = (() => {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(80, Buffer.from([20, 40, 160, 255]))]);
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')}`;
})();

let nowMs = Date.now();
let app;
let server;
let base;
let dataDir;
let cookie = '';
const call = (url, { method = 'GET', body, headers = {} } = {}) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (url, body, opts) => call(url, { method: 'POST', body, ...opts });
const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (link) => new URL(link).searchParams.get('t');
const fileList = () => fs.readdirSync(path.join(dataDir, 'files')).sort();

async function pdfBase64() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save()).toString('base64');
}
const SIG = { type: 'signature', page: 1, x: 0.6, y: 0.85, w: 0.25, h: 0.06 };

async function newGroup(title, extra = {}) {
  const r = await json(await post('/api/groups', {
    title,
    fileName: 'a.pdf',
    pdfBase64: await pdfBase64(),
    requireVerification: false,
    members: [{ name: '홍길동', phone: '010-1111-2222' }, { name: '김교육', phone: '010-3333-4444' }],
    fields: [SIG],
    ...extra,
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function sign(link) {
  const t = tokenOf(link);
  const view = await (await call(`/api/sign/${t}`)).json();
  const r = await post(`/api/sign/${t}`, { consent: true, signatures: Object.fromEntries(view.fields.map((f) => [f.id, PNG])) });
  assert.equal(r.status, 200);
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-retention-'));
  app = createApp({ dataDir, adminPassword: PASSWORD, clock: () => nowMs, reminderIntervalMs: 0 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await post('/api/auth/login', { password: PASSWORD })).headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('보관·삭제 API는 관리자만, 인터넷 공개 모드(터널)로는 차단', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('/api/retention')).status, 401);
  cookie = saved;
  assert.equal((await call('/api/retention', { headers: { 'CF-Connecting-IP': '203.0.113.5' } })).status, 403);
});

test('교육생 일괄 요청 삭제: 확인 필요, 파일·기록·링크가 모두 사라지고 파기 기록만 남는다', async () => {
  const before = fileList();
  const g = await newGroup('2026 안전교육 서약서');
  await sign(g.members[0].signLink);
  const doc = await (await call(`/api/documents/${g.members[0].docId}`)).json();
  assert.ok(fileList().length > before.length, '원본·서명 이미지·완료 PDF가 생김');

  assert.equal((await post(`/api/groups/${g.id}/delete`, {})).status, 400, '확인 없이는 안 지움');
  assert.equal((await post(`/api/groups/${g.id}/delete`, { confirm: 'yes' })).status, 400);
  assert.equal((await post(`/api/documents/${g.members[0].docId}/delete`, { confirm: 'delete' })).status, 400, '일괄 요청의 문서는 따로 못 지움');

  const r = await json(await post(`/api/groups/${g.id}/delete`, { confirm: 'delete' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(fileList(), before, '이 요청의 파일이 모두 지워짐');
  assert.equal((await call(`/api/groups/${g.id}`)).status, 404);
  assert.equal((await call(`/api/documents/${g.members[0].docId}`)).status, 404);
  assert.equal((await call(`/api/sign/${tokenOf(g.members[1].signLink)}`)).status, 404, '서명 링크도 끝');
  assert.equal((await json(await post('/api/verify', { hash: doc.completedHash }))).body.match, null, '등록 대조도 끝');
  assert.equal((await (await call('/api/groups')).json()).some((x) => x.id === g.id), false);

  const ret = await (await call('/api/retention')).json();
  const log = ret.deletions[0];
  assert.deepEqual([log.reason, log.kind, log.title, log.people, log.signed], ['manual', 'group', '2026 안전교육 서약서', 2, 1]);
  const raw = JSON.stringify(ret.deletions);
  for (const secret of ['홍길동', '김교육', '010-1111-2222', g.members[0].docId]) assert.ok(!raw.includes(secret), `파기 기록에 "${secret}" 없음`);
  const db = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  assert.ok(!db.includes('010-3333-4444'), 'db.json에서도 개인정보가 사라짐');

  assert.equal((await post(`/api/groups/${g.id}/delete`, { confirm: 'delete' })).status, 404);
});

test('한 문서 여러 명 문서 삭제', async () => {
  const before = fileList();
  const d = await json(await post('/api/documents', {
    title: '근로계약서', fileName: 'c.pdf', pdfBase64: await pdfBase64(),
    signers: [{ name: '갑' }, { name: '을' }],
    fields: [{ ...SIG, signerIndex: 0 }, { ...SIG, x: 0.1, signerIndex: 1 }],
  }));
  assert.equal(d.status, 201);
  await sign(d.body.signers[0].signLink);
  assert.equal((await post(`/api/documents/${d.body.id}/delete`, { confirm: 'delete' })).status, 200);
  assert.deepEqual(fileList(), before);
  assert.equal((await call(`/api/documents/${d.body.id}`)).status, 404);
  const log = (await (await call('/api/retention')).json()).deletions[0];
  assert.deepEqual([log.kind, log.title, log.people, log.signed], ['document', '근로계약서', 2, 1]);
});

test('보관 기간: 설정 검사, 예정일 표시, 기간이 지나면 자동 삭제', async () => {
  assert.equal((await post('/api/settings', { retentionMonths: 4 })).status, 400, '고를 수 없는 기간');
  assert.equal((await (await call('/api/settings')).json()).retentionMonths, 0, '기본은 자동 삭제 안 함');

  const old = await newGroup('지난 기수 동의서');
  // 이번 기수는 기한이 60일 뒤 → 끝난 날이 늦어서 함께 지워지지 않아야 함
  const recent = await newGroup('이번 기수 동의서', { deadline: new Date(nowMs + 60 * DAY).toISOString() });
  assert.equal(app.runRetention(), 0, '꺼져 있으면 아무것도 안 지움');
  assert.equal((await (await call(`/api/groups/${old.id}`)).json()).deleteAt, null);

  assert.equal((await post('/api/settings', { retentionMonths: 6 })).status, 200);
  const view = await (await call(`/api/groups/${old.id}`)).json();
  const deleteAt = Date.parse(view.deleteAt);
  const expected = new Date(view.createdAt);
  expected.setMonth(expected.getMonth() + 6);
  assert.equal(deleteAt, expected.getTime(), '만든 날 + 6개월');

  nowMs = deleteAt - 10 * DAY;
  const ret = await (await call('/api/retention')).json();
  assert.deepEqual(ret.upcoming.map((x) => x.title), ['지난 기수 동의서'], '30일 안 예정은 지난 기수만');
  assert.equal(app.runRetention(), 0, '아직 안 됨');

  nowMs = deleteAt + 1000;
  assert.equal(app.runRetention(), 1);
  assert.equal((await call(`/api/groups/${old.id}`)).status, 404, '지난 기수는 자동 삭제');
  assert.equal((await call(`/api/groups/${recent.id}`)).status, 200, '이번 기수는 남음');
  const log = (await (await call('/api/retention')).json()).deletions[0];
  assert.deepEqual([log.reason, log.title], ['auto', '지난 기수 동의서']);

  await post('/api/settings', { retentionMonths: 0 });
  nowMs = Date.now();
});

test('끝난 날 = 만든 날·기한·마지막 서명 중 가장 늦은 날', async () => {
  await post('/api/settings', { retentionMonths: 3 });
  const deadline = new Date(nowMs + 20 * DAY).toISOString();
  const g = await newGroup('기한 있는 요청', { deadline });
  const expected = new Date(deadline);
  expected.setMonth(expected.getMonth() + 3);
  assert.equal(g.deleteAt, expected.toISOString(), '기한 + 3개월');
  await post('/api/settings', { retentionMonths: 0 });
});
