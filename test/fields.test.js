'use strict';
// 체크 칸·입력란 + 서명 완료본 메일
//  - 만들 때 검사 (항목 이름 길이, 필수 여부 기본값)
//  - 서명할 때 검사 (필수 체크·입력, 형식, 길이)
//  - 완료 PDF에 체크·글자가 찍히고 감사 추적 인증서에 답이 남음
//  - 명단 엑셀에 항목별 열
//  - 서명이 끝나면 이메일이 있는 서명자에게 완료본 PDF 첨부 메일 (설정으로 끄기 가능)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../server');

const PASSWORD = 'fields-test-password';

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
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
})();

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const dir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: `${path.join(dir, 'standard_fonts').replace(/\\/g, '/')}/`,
    verbosity: 0,
  }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i += 1) {
    text += `${(await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join('')}\n`;
  }
  return text;
}

/** ZIP(xlsx) 안의 파일 하나를 글자로 꺼낸다 */
function zipEntryText(buf, wanted) {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} 없음`);
}

let server;
let app;
let base;
let dataDir;
let cookie = '';
const sentMails = [];
const fakeTransport = {
  async sendMail(message) {
    if (message.to.address.startsWith('bounce@')) throw Object.assign(new Error('550 no such user'), { code: 'EENVELOPE', responseCode: 550 });
    sentMails.push(message);
    return { messageId: `<${sentMails.length}@test>` };
  },
};
const call = (url, { method = 'GET', body } = {}) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (url, body) => call(url, { method: 'POST', body });
const json = async (res) => ({ status: res.status, body: await res.json() });

async function blankPdfBase64() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save()).toString('base64');
}

const FIELDS = [
  { type: 'signature', page: 1, x: 0.6, y: 0.85, w: 0.25, h: 0.06 },
  { type: 'checkbox', label: '개인정보 수집·이용 동의', required: true, page: 1, x: 0.1, y: 0.2, w: 0.04, h: 0.03 },
  { type: 'checkbox', label: '사진 활용 동의', required: false, page: 1, x: 0.1, y: 0.3, w: 0.04, h: 0.03 },
  { type: 'text', label: '차량번호', required: false, page: 1, x: 0.1, y: 0.4, w: 0.3, h: 0.04 },
  { type: 'text', label: '비상 연락처', page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.04 }, // required 생략 → 필수
];

async function newGroup(members, fields = FIELDS) {
  const r = await json(await post('/api/groups', {
    title: '개인정보 동의서',
    fileName: 'a.pdf',
    pdfBase64: await blankPdfBase64(),
    requireVerification: false,
    members,
    fields,
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const tokenOfLink = (link) => new URL(link).searchParams.get('t');

/** 교육생 1명: 필수 칸을 채워 서명 */
async function signMember(member) {
  const t = tokenOfLink(member.signLink);
  const view = await (await call(`/api/sign/${t}`)).json();
  const values = Object.fromEntries(view.fields.filter((f) => f.type === 'checkbox' || f.type === 'text')
    .map((f) => [f.id, f.type === 'checkbox' ? true : '내용']));
  const sig = Object.fromEntries(view.fields.filter((f) => f.type === 'signature').map((f) => [f.id, PNG]));
  const r = await post(`/api/sign/${t}`, { consent: true, signatures: sig, values });
  assert.equal(r.status, 200, await r.clone().text());
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-fields-'));
  app = createApp({ dataDir, adminPassword: PASSWORD, mailTransport: fakeTransport });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await post('/api/auth/login', { password: PASSWORD })).headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('만들 때: 항목 이름 기본값·길이 검사, 필수 기본값', async () => {
  const pdfBase64 = await blankPdfBase64();
  const make = (fields) => post('/api/groups', { title: 't', fileName: 'a.pdf', pdfBase64, requireVerification: false, members: [{ name: 'A' }], fields });
  const sig = FIELDS[0];
  assert.equal((await make([sig, { ...FIELDS[1], label: 'x'.repeat(61) }])).status, 400, '항목 이름 60자 초과');
  assert.equal((await make([sig, { ...FIELDS[1], type: 'radio' }])).status, 400, '없는 칸 종류');

  const g = await newGroup([{ name: '기본값' }], [sig, { type: 'checkbox', page: 1, x: 0.1, y: 0.2, w: 0.04, h: 0.03 }]);
  const view = await (await call(`/api/sign/${tokenOfLink(g.members[0].signLink)}`)).json();
  const box = view.fields.find((f) => f.type === 'checkbox');
  assert.equal(box.label, '체크 항목');
  assert.equal(box.required, true);
  assert.equal(box.value, null);
});

test('서명할 때: 필수 항목·형식·길이 검사 후 완료, PDF·감사 기록·엑셀에 답이 남음', async () => {
  const g = await newGroup([{ name: '홍길동', email: 'hong@example.com' }]);
  const t = tokenOfLink(g.members[0].signLink);
  const view = await (await call(`/api/sign/${t}`)).json();
  const id = (label) => view.fields.find((f) => f.label === label).id;
  const sig = { [view.fields.find((f) => f.type === 'signature').id]: PNG };
  const good = { [id('개인정보 수집·이용 동의')]: true, [id('사진 활용 동의')]: false, [id('차량번호')]: '12가 3456', [id('비상 연락처')]: '010-9999-8888' };
  const sign = (values) => post(`/api/sign/${t}`, { consent: true, signatures: sig, values }).then(json);

  let r = await sign({ ...good, [id('개인정보 수집·이용 동의')]: false });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /필수 항목 "개인정보 수집·이용 동의"에 체크/);
  r = await sign({ ...good, [id('비상 연락처')]: '   ' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /"비상 연락처" 칸을 입력/);
  assert.equal((await sign({ ...good, [id('사진 활용 동의')]: 'yes' })).status, 400, '체크 값은 true/false만');
  assert.equal((await sign({ ...good, [id('차량번호')]: 'x'.repeat(201) })).status, 400, '200자 초과');
  assert.equal((await post(`/api/sign/${t}`, { consent: true, signatures: sig, values: [] }).then(json)).status, 400, '배열은 거절');

  r = await sign({ ...good, [id('차량번호')]: ' 12가\n3456 ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.documentStatus, 'completed');

  const doc = await (await call(`/api/documents/${g.members[0].docId}`)).json();
  const value = (label) => doc.fields.find((f) => f.label === label).value;
  assert.equal(value('개인정보 수집·이용 동의'), true);
  assert.equal(value('사진 활용 동의'), false);
  assert.equal(value('차량번호'), '12가 3456', '줄바꿈 → 공백, 앞뒤 공백 제거');

  const pdf = Buffer.from(await (await call(`/api/documents/${doc.id}/completed.pdf`)).arrayBuffer());
  const text = await pdfText(pdf);
  assert.match(text, /12가 3456/, '입력값이 문서에 찍힘');
  assert.match(text, /010-9999-8888/);
  assert.match(text, /개인정보 수집·이용 동의 \[필수\]: 예 \(체크함\)/);
  assert.match(text, /사진 활용 동의 \[선택\]: 아니오 \(체크 안 함\)/);

  const xlsx = Buffer.from(await (await call(`/api/groups/${g.id}/roster.xlsx`)).arrayBuffer());
  const sheet = zipEntryText(xlsx, 'xl/worksheets/sheet1.xml');
  for (const s of ['개인정보 수집·이용 동의', '사진 활용 동의', '차량번호', '12가 3456', '아니오']) assert.ok(sheet.includes(s), `엑셀에 "${s}"`);
});

test('서명이 끝나면 완료본 PDF를 첨부해 메일로 보낸다', async () => {
  const g = await newGroup([{ name: '김메일', email: 'mail@example.com' }, { name: '메일없음' }]);
  const before = sentMails.length;
  for (const m of g.members) await signMember(m);
  await app.flushMails();
  const mails = sentMails.slice(before);
  assert.equal(mails.length, 1, '이메일 있는 사람에게만');
  const [m] = mails;
  assert.equal(m.to.address, 'mail@example.com');
  assert.equal(m.subject, '[서명 완료] 개인정보 동의서');
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].filename, /\.pdf$/);
  assert.equal(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-');

  const doc = await (await call(`/api/documents/${g.members[0].docId}`)).json();
  assert.ok(doc.signers[0].completedMailAt);
  assert.ok(doc.events.some((e) => e.type === 'completed_mail_sent'));
});

test('완료본 메일 실패는 기록되고, 설정에서 끄면 보내지 않는다', async () => {
  const signOne = async (g) => {
    await signMember(g.members[0]);
    await app.flushMails();
    return (await call(`/api/documents/${g.members[0].docId}`)).json();
  };

  const failed = await signOne(await newGroup([{ name: '반송', email: 'bounce@example.com' }]));
  assert.equal(failed.signers[0].completedMailAt, null);
  assert.ok(failed.signers[0].completedMailError);
  assert.ok(failed.events.some((e) => e.type === 'completed_mail_failed'));

  const settings = await post('/api/settings', { sendCompletedCopy: false }).then(json);
  assert.equal(settings.body.sendCompletedCopy, false);
  const before = sentMails.length;
  await signOne(await newGroup([{ name: '안보냄', email: 'off@example.com' }]));
  assert.equal(sentMails.length, before, '꺼져 있으면 보내지 않음');
  await post('/api/settings', { sendCompletedCopy: true });
});

test('한 문서에 여러 명: 자기 칸만 보이고, 마지막 사람이 서명하면 모두에게 완료본 메일', async () => {
  const r = await post('/api/documents', {
    title: '공동 서약서',
    fileName: 'a.pdf',
    pdfBase64: await blankPdfBase64(),
    signers: [{ name: '갑', email: 'a@example.com' }, { name: '을', email: 'b@example.com' }],
    fields: [
      { signerIndex: 0, type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { signerIndex: 1, type: 'signature', page: 1, x: 0.6, y: 0.8, w: 0.25, h: 0.06 },
      { signerIndex: 1, type: 'text', label: '을의 주소', page: 1, x: 0.6, y: 0.7, w: 0.3, h: 0.04 },
    ],
  }).then(json);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const before = sentMails.length;
  for (const s of r.body.signers) {
    const view = await (await call(`/api/sign/${tokenOfLink(s.signLink)}`)).json();
    assert.equal(view.fields.some((f) => f.type === 'text'), s.name === '을', '자기 칸만 보임');
    await signMember(s);
  }
  await app.flushMails();
  assert.deepEqual(sentMails.slice(before).map((m) => m.to.address).sort(), ['a@example.com', 'b@example.com']);
});
