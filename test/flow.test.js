'use strict';
// 전체 흐름 테스트
//  - 관리자 로그인, 입력 검사
//  - 한 문서에 여러 명 서명 → 완료 PDF → PAdES 전자서명 검증 (+ OpenSSL 독립 검증)
//  - 교육생 일괄 서명 → 취소·추가 → 서명부 PDF / CSV / ZIP
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PDFDocument, degrees } = require('pdf-lib');
const { createApp, lanAddresses } = require('../server');
const { placeField } = require('../lib/finalize');
const { verifyPdfSignatures } = require('../lib/cades');

const ADMIN_PASSWORD = 'test-password-123';

/** 단색 RGBA PNG를 직접 만들어 data URL로 돌려준다 */
function pngDataUrl(width = 40, height = 12) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, Buffer.from([20, 40, 160, 255]))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const PNG = pngDataUrl();

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Contract page 1', { x: 50, y: 780 });
  const p2 = pdf.addPage([595, 842]);
  p2.setRotation(degrees(90)); // 회전된 페이지도 처리되는지
  return Buffer.from(await pdf.save());
}

/** pdf.js로 PDF의 글자를 뽑는다 (자동 입력된 이름·날짜, 서명부 내용 확인용) */
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
    const content = await (await doc.getPage(i)).getTextContent();
    text += `${content.items.map((it) => it.str).join('')}\n`;
  }
  return { text, pages: doc.numPages };
}

/** ZIP 파일 안의 항목을 읽는다 (중앙 디렉터리 기준) */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'ZIP 끝 레코드');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name} CRC`);
    entries.push({ name, data, utf8: Boolean(flags & 0x0800) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

let server;
let base;
let dataDir;
let cookie = '';

const call = (url, { method = 'GET', body, auth = true, headers = {} } = {}) => fetch(base + url, {
  method,
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(auth && cookie ? { Cookie: cookie } : {}),
    'X-Requested-With': 'esign',
    ...headers,
  },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (url, body, opts) => call(url, { method: 'POST', body, ...opts });
const getJson = async (url) => (await call(url)).json();
const tokenOf = (link) => new URL(link, base).searchParams.get('t');

// 실제로 보내지 않고 기록만 하는 메일 transport (bounce@ 주소는 거절)
const sentMails = [];
const fakeTransport = {
  async sendMail(message) {
    if (message.to.address.startsWith('bounce@')) throw Object.assign(new Error('550 no such user'), { code: 'EENVELOPE' });
    sentMails.push(message);
    return { messageId: `<${sentMails.length}@test>` };
  },
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-test-'));
  server = createApp({ dataDir, adminPassword: ADMIN_PASSWORD, mailTransport: fakeTransport }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('placeField: 회전별 좌표 변환', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const f = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
  let r = placeField(page, f);
  assert.deepEqual([r.x, r.y, r.width, r.height].map(Math.round), [60, 560, 180, 80]);
  page.setRotation(degrees(90)); // 화면에서는 800x600으로 보임
  r = placeField(page, f);
  assert.deepEqual([r.x, r.y, r.width, r.height].map(Math.round), [180, 80, 240, 60]);
});

test('관리자 로그인: 관리자 API는 로그인 필요, 서명·검증 API는 공개', async () => {
  assert.equal((await call('/api/documents')).status, 401);
  assert.equal((await call('/api/groups')).status, 401);
  assert.equal((await call('/api/server-info')).status, 401);
  assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 401);
  assert.equal((await post('/api/auth/setup', { password: 'another-password' })).status, 409, '이미 설정됨');

  const ok = await post('/api/auth/login', { password: ADMIN_PASSWORD });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  cookie = setCookie.split(';')[0];

  assert.equal((await call('/api/documents')).status, 200);
  assert.equal((await getJson('/api/auth/status')).loggedIn, true);
  // 우리 화면이 붙이는 헤더가 없는 쓰기 요청은 거절 (CSRF 방지)
  assert.equal((await post('/api/groups', {}, { headers: { 'X-Requested-With': '' } })).status, 403);

  assert.equal((await call('/api/sign/nope', { auth: false })).status, 404, '서명 API는 로그인 없이 접근');
  assert.equal((await post('/api/verify', { hash: 'x' }, { auth: false })).status, 400, '검증 API는 공개');
});

test('잘못된 요청은 거절', async () => {
  const pdf = (await samplePdf()).toString('base64');
  const field = { signerIndex: 0, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 };
  const good = { title: 't', pdfBase64: pdf, signers: [{ name: 'A' }], fields: [field] };

  assert.equal((await post('/api/documents', { ...good, pdfBase64: Buffer.from('hello').toString('base64') })).status, 400);
  assert.equal((await post('/api/documents', { ...good, title: '' })).status, 400);
  assert.equal((await post('/api/documents', { ...good, fields: [{ ...field, page: 9 }] })).status, 400);
  assert.equal((await post('/api/documents', { ...good, fields: [{ ...field, x: 0.95 }] })).status, 400);
  assert.equal((await post('/api/documents', { ...good, fields: [{ ...field, type: 'stamp' }] })).status, 400, '없는 칸 종류');
  assert.equal((await post('/api/documents', { ...good, fields: [{ ...field, type: 'name' }] })).status, 400, '서명 칸 없이 이름 칸만');
  assert.equal((await post('/api/documents', { ...good, signers: [{ name: 'A' }, { name: 'B' }] })).status, 400, '서명란 없는 서명자');
  assert.equal((await post('/api/documents', { ...good, signers: [{ name: 'A', phone: 'abc' }] })).status, 400, '연락처 형식');
});

let signedPdf;

test('전체 서명 흐름 (한 문서에 2명)', async () => {
  const res = await post('/api/documents', {
    title: '근로계약서',
    fileName: '계약서.pdf',
    pdfBase64: (await samplePdf()).toString('base64'),
    signers: [{ name: '김철수', email: 'kim@example.com' }, { name: '이영희' }],
    fields: [
      { signerIndex: 0, page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { signerIndex: 0, page: 2, x: 0.5, y: 0.5, w: 0.25, h: 0.06 },
      { signerIndex: 1, page: 1, x: 0.6, y: 0.8, w: 0.25, h: 0.06 },
    ],
  });
  assert.equal(res.status, 201);
  const doc = await res.json();
  assert.equal(doc.status, 'pending');
  assert.ok(doc.signers[0].signLink.startsWith(base), '서명 링크는 전체 주소');
  const [kim, lee] = doc.signers.map((s) => tokenOf(s.signPath));

  const kimView = await (await call(`/api/sign/${kim}`, { auth: false })).json();
  assert.equal(kimView.fields.length, 2, '본인 서명란만 보임');
  assert.equal((await call(`/api/sign/${kim}/document.pdf`, { auth: false })).status, 200);

  const kimSigs = Object.fromEntries(kimView.fields.map((f) => [f.id, PNG]));
  assert.equal((await post(`/api/sign/${kim}`, { consent: false, signatures: kimSigs })).status, 400, '동의 없음');
  assert.equal((await post(`/api/sign/${kim}`, { consent: true, signatures: { [kimView.fields[0].id]: PNG } })).status, 400, '서명란 누락');
  assert.equal((await post(`/api/sign/${kim}`, { consent: true, signatures: { ...kimSigs, [kimView.fields[0].id]: 'data:image/png;base64,AAAA' } })).status, 400, 'PNG 아님');

  const kimDone = await post(`/api/sign/${kim}`, { consent: true, signatures: kimSigs }, { auth: false });
  assert.equal(kimDone.status, 200);
  assert.equal((await kimDone.json()).documentStatus, 'pending');
  assert.equal((await post(`/api/sign/${kim}`, { consent: true, signatures: kimSigs })).status, 409, '중복 서명');
  assert.equal((await call(`/api/documents/${doc.id}/completed.pdf`)).status, 409, '완료 전 다운로드 불가');

  const leeView = await (await call(`/api/sign/${lee}`, { auth: false })).json();
  const leeDone = await post(`/api/sign/${lee}`, { consent: true, signatures: { [leeView.fields[0].id]: PNG } }, { auth: false });
  assert.equal((await leeDone.json()).documentStatus, 'completed');

  const final = await getJson(`/api/documents/${doc.id}`);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.events.map((e) => e.type), ['created', 'viewed', 'signed', 'viewed', 'signed', 'completed']);

  const completedRes = await call(`/api/documents/${doc.id}/completed.pdf?download`);
  assert.equal(completedRes.status, 200);
  assert.match(completedRes.headers.get('content-disposition'), /attachment/);
  const completed = Buffer.from(await completedRes.arrayBuffer());
  assert.ok((await PDFDocument.load(completed)).getPageCount() >= 3, '원본 2쪽 + 감사 추적 인증서');

  const hash = crypto.createHash('sha256').update(completed).digest('hex');
  assert.equal(hash, final.completedHash);
  const ok = await (await post('/api/verify', { hash })).json();
  assert.equal(ok.match, 'completed');
  assert.equal(ok.signers.length, 2);

  const tampered = Buffer.from(completed);
  tampered[tampered.length - 10] ^= 1;
  const bad = await (await post('/api/verify', { hash: crypto.createHash('sha256').update(tampered).digest('hex') })).json();
  assert.equal(bad.match, null, '변조된 파일은 검증 실패');

  if (process.env.SAVE_OUTPUT) fs.writeFileSync(process.env.SAVE_OUTPUT, completed); // 눈으로 확인용
  signedPdf = completed;
});

// ───── PDF 전자서명(PAdES) ─────
const verifySig = async (buf) => (await post('/api/verify-signature', { pdfBase64: Buffer.from(buf).toString('base64') }, { auth: false })).json();
const byteRangeOf = (buf) => /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(buf.toString('latin1')).slice(1, 5).map(Number);

test('완료 PDF에 유효한 PAdES 전자서명이 들어감', async () => {
  assert.ok(signedPdf, '전체 서명 흐름 테스트가 먼저 실행되어야 함');
  const r = await verifySig(signedPdf);
  assert.equal(r.signed, true);
  assert.equal(r.valid, true);
  assert.equal(r.trusted, true);
  assert.equal(r.modifiedAfterSigning, false);
  const [s] = r.signatures;
  assert.equal(s.subFilter, 'ETSI.CAdES.detached');
  assert.equal(s.hasSigningCertificateV2, true);
  assert.equal(s.signer.subject, 'e서명 문서 봉인');
  assert.equal(s.signer.issuer, 'e서명 루트 CA');
  assert.equal(s.reason, '모든 서명자의 서명 완료 — 문서 봉인');
  assert.deepEqual(s.errors, []);

  const seal = await (await call('/api/seal', { auth: false })).json();
  assert.equal(seal.fingerprint256, s.signer.fingerprint256);
  assert.match(await (await call('/api/seal/ca.crt', { auth: false })).text(), /BEGIN CERTIFICATE/);
});

test('서명 이후 변조·추가 수정은 검출', async () => {
  const br = byteRangeOf(signedPdf);
  const tampered = Buffer.from(signedPdf);
  tampered[Math.floor(br[1] / 2)] ^= 0x01;
  const t = await verifySig(tampered);
  assert.equal(t.valid, false);
  assert.equal(t.signatures[0].integrity, false);

  const appended = Buffer.concat([signedPdf, Buffer.from('\n1 0 obj\n(tampered)\nendobj\n%%EOF\n')]);
  const a = await verifySig(appended);
  assert.equal(a.signatures[0].integrity, true, '원래 서명 범위는 그대로');
  assert.equal(a.modifiedAfterSigning, true);
  assert.equal(a.valid, false);

  const unsigned = await verifySig(await samplePdf());
  assert.equal(unsigned.signed, false);
});

test('서명 인증서를 신뢰하지 않으면 trusted=false (서명 자체는 유효)', () => {
  const r = verifyPdfSignatures(signedPdf, []);
  assert.equal(r.valid, true);
  assert.equal(r.trusted, false);
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('OpenSSL로 독립 검증 (CMS 서명 + 인증서 체인)', { skip: !hasOpenssl && 'openssl 없음' }, () => {
  const br = byteRangeOf(signedPdf);
  const content = Buffer.concat([signedPdf.subarray(br[0], br[1]), signedPdf.subarray(br[2], br[2] + br[3])]);
  const raw = Buffer.from(signedPdf.subarray(br[1] + 1, br[2] - 1).toString('latin1'), 'hex');
  const n = raw[1] & 0x7f;
  const len = raw[1] < 0x80 ? 2 + raw[1] : 2 + n + raw.subarray(2, 2 + n).reduce((acc, b) => acc * 256 + b, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-ossl-'));
  try {
    fs.writeFileSync(path.join(dir, 'sig.der'), raw.subarray(0, len));
    fs.writeFileSync(path.join(dir, 'content.bin'), content);
    const run = (contentFile) => spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER',
      '-in', path.join(dir, 'sig.der'), '-content', contentFile,
      '-CAfile', path.join(dataDir, 'keys', 'ca.crt.pem'), '-purpose', 'any', '-out', os.devNull], { encoding: 'utf8' });

    const ok = run(path.join(dir, 'content.bin'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /Verification successful/);

    const changed = Buffer.from(content);
    changed[100] ^= 1;
    fs.writeFileSync(path.join(dir, 'changed.bin'), changed);
    assert.notEqual(run(path.join(dir, 'changed.bin')).status, 0, '변경된 내용은 OpenSSL에서도 실패');

    const printed = spawnSync('openssl', ['cms', '-cmsout', '-print', '-inform', 'DER', '-in', path.join(dir, 'sig.der')], { encoding: 'utf8' }).stdout;
    assert.match(printed, /id-smime-aa-signingCertificateV2/);
    assert.doesNotMatch(printed, /signingTime/, 'PAdES는 signing-time 속성을 쓰지 않음');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───── 교육생 일괄 서명 → 메일 발송 → 본인 확인 → 서명자 명단 ─────

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const waitForSending = async (groupId) => {
  for (let i = 0; i < 100; i += 1) {
    const g = await getJson(`/api/groups/${groupId}`);
    if (!g.mail.sending?.running) return g;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('메일 발송이 끝나지 않음');
};
/** 본인 확인 → 서명 제출. 성공하면 서명자 쿠키를 돌려준다 */
async function verifyAndSign(link, name, phone) {
  const t = tokenOf(link);
  const v = await post(`/api/sign/${t}/verify`, { name, phone }, { auth: false });
  assert.equal(v.status, 200, `${name} 본인 확인`);
  const sv = cookieOf(v);
  const view = await v.json();
  const sigField = view.fields.find((f) => f.type === 'signature');
  const r = await post(`/api/sign/${t}`, { consent: true, signatures: { [sigField.id]: PNG } }, { auth: false, headers: { Cookie: sv } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).documentStatus, 'completed', '1인 1부라 본인 서명으로 바로 완료');
  return sv;
}
const xlsxSheet = (buf) => readZip(buf).find((e) => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
/** 시트의 각 행을 배열로 (빈 셀은 생략되므로 셀 주소의 열 문자로 위치를 정한다) */
const xlsxRows = (buf) => [...xlsxSheet(buf).matchAll(/<row r="\d+">(.*?)<\/row>/g)].map((m) => {
  const row = [];
  for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>)/g)) {
    const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    row[col] = c[2] ?? c[3] ?? '';
  }
  return Array.from(row, (v) => v ?? '');
});

let group;

test('교육생 일괄: 생성(본인 확인 필수) → 메일 발송', async () => {
  const fields = [
    { type: 'signature', page: 1, x: 0.6, y: 0.8, w: 0.25, h: 0.06 },
    { type: 'name', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.04 },
    { type: 'date', page: 1, x: 0.35, y: 0.8, w: 0.2, h: 0.04 },
  ];
  const body = {
    title: '개인정보 수집·이용 동의서',
    info: '일시: 2026. 11. 10.(화) 14:00\n장소: 3층 강의실',
    fileName: '동의서.pdf',
    pdfBase64: (await samplePdf()).toString('base64'),
    fields,
    members: [
      { name: '김교육', org: '1반', phone: '010-1111-2222', email: 'kim@example.com' },
      { name: '이수강', org: '=HYPERLINK("http://evil")', phone: '01033334444', email: 'lee@example.com' },
      { name: '박잠김', phone: '010-5555-6666', email: 'bounce@example.com' },
      { name: '최메일없음', phone: '010-7777-8888' },
    ],
  };
  assert.equal((await post('/api/groups', { ...body, members: [{ name: '전화없음', email: 'x@example.com' }] })).status, 400, '본인 확인을 쓰면 전화번호 필수');

  const created = await post('/api/groups', body);
  assert.equal(created.status, 201);
  group = await created.json();
  assert.equal(group.requireVerification, true);
  assert.deepEqual(group.counts, { total: 4, signed: 0 });
  assert.deepEqual(group.mail, { configured: true, sending: null, sent: 0, failed: 0, noEmail: 1 });
  assert.equal(group.link.reach, 'local');
  assert.equal(new Set(group.members.map((m) => m.signLink)).size, 4, '교육생마다 다른 링크');

  // 링크 주소가 localhost면 메일을 받은 사람이 열 수 없으므로 발송 거절
  const local = await post(`/api/groups/${group.id}/send`, { scope: 'unsent' });
  assert.equal(local.status, 400);
  assert.equal((await local.json()).code, 'link_local');

  // 설정에서 서명 링크 주소 지정 → 발송
  const s = await post('/api/settings', { publicUrl: 'https://sign.example.com/' });
  assert.equal((await s.json()).publicUrl, 'https://sign.example.com');
  assert.equal((await post('/api/settings', { publicUrl: 'javascript:alert(1)' })).status, 400);

  const sent = await post(`/api/groups/${group.id}/send`, { scope: 'unsent' });
  assert.equal(sent.status, 202);
  assert.equal((await sent.json()).queued, 3, '이메일 없는 사람은 제외');
  group = await waitForSending(group.id);
  assert.deepEqual({ sent: group.mail.sent, failed: group.mail.failed }, { sent: 2, failed: 1 });
  const bounced = group.members.find((m) => m.name === '박잠김');
  assert.equal(bounced.emailStatus, 'failed');
  assert.match(bounced.emailError, /받는 사람 이메일/);

  const kimMail = sentMails.find((m) => m.to.address === 'kim@example.com');
  const kim = group.members.find((m) => m.name === '김교육');
  assert.ok(kim.signLink.startsWith('https://sign.example.com/sign.html?t='));
  assert.equal(kimMail.subject, '[서명 요청] 개인정보 수집·이용 동의서');
  assert.ok(kimMail.html.includes(kim.signLink), '메일 본문에 본인 링크');
  assert.ok(kimMail.text.includes(kim.signLink));
  assert.ok(kimMail.html.includes('이름과 전화번호'), '본인 확인 안내');
  const leeLink = group.members.find((x) => x.name === '이수강').signLink;
  assert.ok(!kimMail.html.includes(leeLink), '다른 사람 링크는 안 들어감');

  // 메일 주소 고쳐서 한 명만 다시 보내기
  const fixed = await (await post(`/api/groups/${group.id}/members/${bounced.docId}`, { name: '박잠김', phone: '010-5555-6666', email: 'park@example.com' })).json();
  assert.equal(fixed.members.find((m) => m.name === '박잠김').emailStatus, null, '주소를 바꾸면 발송 상태 초기화');
  assert.equal((await post(`/api/groups/${group.id}/send`, { scope: 'one', docId: bounced.docId })).status, 202);
  group = await waitForSending(group.id);
  assert.equal(group.members.find((m) => m.name === '박잠김').emailStatus, 'sent');

  // 미서명자 전체 다시 알림 → 제목이 [다시 알림]
  const before = sentMails.length;
  await post(`/api/groups/${group.id}/send`, { scope: 'unsigned' });
  group = await waitForSending(group.id);
  assert.equal(sentMails.length - before, 3);
  assert.ok(sentMails.slice(before).every((m) => m.subject.startsWith('[다시 알림]')));
});

test('교육생 일괄: 이름+전화번호 본인 확인 후에만 문서·서명 가능', async () => {
  const kim = group.members.find((m) => m.name === '김교육');
  const t = tokenOf(kim.signLink);

  // 확인 전: 누구 링크인지, 문서 내용 모두 비공개
  const before = await (await call(`/api/sign/${t}`, { auth: false })).json();
  assert.deepEqual(before, { verificationRequired: true, documentTitle: group.title });
  assert.equal((await call(`/api/sign/${t}/document.pdf`, { auth: false })).status, 403);
  assert.equal((await post(`/api/sign/${t}`, { consent: true, signatures: {} }, { auth: false })).status, 403);

  const wrong = await post(`/api/sign/${t}/verify`, { name: '김교육', phone: '010-0000-0000' }, { auth: false });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /남은 시도 4회/);

  // 띄어쓰기·하이픈·+82 형식이 달라도 같은 사람으로 인정
  const ok = await post(`/api/sign/${t}/verify`, { name: ' 김 교육 ', phone: '+82 10 1111 2222' }, { auth: false });
  assert.equal(ok.status, 200);
  const sv = cookieOf(ok);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/api\/sign/);
  const view = await ok.json();
  assert.equal(view.signer.name, '김교육');
  assert.deepEqual(view.fields.map((f) => f.type).sort(), ['date', 'name', 'signature']);
  assert.equal((await call(`/api/sign/${t}/document.pdf`, { auth: false, headers: { Cookie: sv } })).status, 200);

  // 김교육의 확인 쿠키로 다른 교육생 문서는 못 엶
  const leeToken = tokenOf(group.members.find((m) => m.name === '이수강').signLink);
  assert.equal((await call(`/api/sign/${leeToken}/document.pdf`, { auth: false, headers: { Cookie: sv } })).status, 403);

  // 5번 틀리면 15분 잠김 (맞게 입력해도 거절)
  const parkToken = tokenOf(group.members.find((m) => m.name === '박잠김').signLink);
  for (let i = 0; i < 5; i += 1) await post(`/api/sign/${parkToken}/verify`, { name: '박잠김', phone: '010-9999-9999' }, { auth: false });
  const locked = await post(`/api/sign/${parkToken}/verify`, { name: '박잠김', phone: '010-5555-6666' }, { auth: false });
  assert.equal(locked.status, 429);

  await verifyAndSign(kim.signLink, '김교육', '010-1111-2222');
  await verifyAndSign(group.members.find((m) => m.name === '이수강').signLink, '이수강', '010-3333-4444');

  const kimPdf = Buffer.from(await (await call(`/api/documents/${kim.docId}/completed.pdf`)).arrayBuffer());
  const sig = verifyPdfSignatures(kimPdf, [fs.readFileSync(path.join(dataDir, 'keys', 'ca.crt.pem'), 'utf8')]);
  assert.equal(sig.valid && sig.trusted, true);
  const text = (await pdfText(kimPdf)).text;
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.ok(text.includes('김교육') && text.includes(today), '이름·날짜 자동 입력');
  assert.ok(text.includes('이름·전화번호 일치 확인'), '감사 추적에 본인 확인 기록');
  assert.ok(text.includes('kim@example.com 로 발송'), '감사 추적에 메일 발송 기록');
  assert.ok(text.includes('본인 확인 실패'), '감사 추적에 실패 시도 기록');
});

test('교육생 일괄: 취소·추가·서명자 명단 PDF/엑셀/ZIP', async () => {
  const choi = group.members.find((m) => m.name === '최메일없음');
  assert.equal((await post(`/api/groups/${group.id}/members/${choi.docId}/cancel`, {})).status, 200);
  assert.equal((await call(`/api/sign/${tokenOf(choi.signLink)}`, { auth: false })).status, 410);
  const kim = group.members.find((m) => m.name === '김교육');
  assert.equal((await post(`/api/groups/${group.id}/members/${kim.docId}/cancel`, {})).status, 409, '서명한 사람은 취소 불가');
  assert.equal((await post(`/api/groups/${group.id}/members/${kim.docId}`, { name: '김교육', phone: '010-1111-2222' })).status, 409, '서명한 사람은 수정 불가');

  const added = await (await post(`/api/groups/${group.id}/members`, { members: [{ name: '한지각', org: '2반', phone: '010-1212-3434' }] })).json();
  assert.deepEqual(added.counts, { total: 4, signed: 2 });

  // 서명자 명단 PDF (기본: 서명한 사람만)
  const caPem = fs.readFileSync(path.join(dataDir, 'keys', 'ca.crt.pem'), 'utf8');
  const listPdf = Buffer.from(await (await call(`/api/groups/${group.id}/roster.pdf?download`)).arrayBuffer());
  const listSig = verifyPdfSignatures(listPdf, [caPem]);
  assert.equal(listSig.valid && listSig.trusted, true);
  assert.equal(listSig.signatures[0].reason, '서명자 명단 발급');
  const listText = (await pdfText(listPdf)).text;
  for (const s of ['서명자 명단', group.title, '장소: 3층 강의실', '김교육', '이수강', '010-****-2222', '서명 2명 (전체 4명 중)']) {
    assert.ok(listText.includes(s), `명단에 "${s}" 포함`);
  }
  for (const s of ['박잠김', '한지각', '010-1111-2222']) assert.ok(!listText.includes(s), `명단에 "${s}" 없음`);
  if (process.env.SAVE_LIST) fs.writeFileSync(process.env.SAVE_LIST, listPdf);

  // 전체 현황 PDF (?all)
  const allText = (await pdfText(Buffer.from(await (await call(`/api/groups/${group.id}/roster.pdf?all`)).arrayBuffer()))).text;
  for (const s of ['서명 현황', '박잠김', '한지각', '미서명', '총 4명 · 서명 2명 · 미서명 2명']) assert.ok(allText.includes(s), `현황에 "${s}" 포함`);
  assert.ok(!allText.includes('최메일없음'), '취소한 사람 제외');

  // 엑셀 (.xlsx)
  const xRes = await call(`/api/groups/${group.id}/roster.xlsx`);
  assert.equal(xRes.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(decodeURIComponent(xRes.headers.get('content-disposition')), /서명자명단_개인정보 수집·이용 동의서\.xlsx/);
  const xlsx = Buffer.from(await xRes.arrayBuffer());
  if (process.env.SAVE_XLSX) fs.writeFileSync(process.env.SAVE_XLSX, xlsx);
  const rows = xlsxRows(xlsx);
  assert.deepEqual(rows[0].slice(0, 6), ['번호', '이름', '소속', '연락처', '이메일', '상태']);
  assert.equal(rows.length, 3, '머리글 + 서명자 2명');
  assert.deepEqual(rows[1].slice(0, 6), ['1', '김교육', '1반', '010-1111-2222', 'kim@example.com', '서명 완료']);
  assert.equal(rows[2][2], '=HYPERLINK(&quot;http://evil&quot;)', '수식이 아닌 텍스트 셀로 저장');
  assert.match(xlsxSheet(xlsx), /t="inlineStr"><is><t xml:space="preserve">01033334444/, '전화번호 앞 0 유지(텍스트)');
  const allRows = xlsxRows(Buffer.from(await (await call(`/api/groups/${group.id}/roster.xlsx?all`)).arrayBuffer()));
  assert.equal(allRows.length, 5);
  assert.ok(allRows.find((r) => r[1] === '박잠김')[11].includes('/sign.html?t='), '현황에는 미서명자 링크');

  // 서명 완료 PDF 묶음
  const entries = readZip(Buffer.from(await (await call(`/api/groups/${group.id}/signed.zip`)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['001_김교육_서명완료.pdf', '002_이수강_서명완료.pdf']);
  assert.ok(entries.every((e) => e.utf8));

  assert.ok(!(await getJson('/api/documents')).some((d) => d.title === group.title), '개별 문서함에 섞이지 않음');
});

test('일괄 요청 입력 검사', async () => {
  const pdf = (await samplePdf()).toString('base64');
  const good = { title: '교육', pdfBase64: pdf, fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], members: [{ name: 'A', phone: '010-1234-5678' }] };
  assert.equal((await post('/api/groups', good)).status, 201);
  assert.equal((await post('/api/groups', { ...good, requireVerification: false, members: [{ name: '전화없음' }] })).status, 201, '본인 확인 끄면 전화번호 선택');
  assert.equal((await post('/api/groups', { ...good, members: [] })).status, 400, '명단 없음');
  assert.equal((await post('/api/groups', { ...good, members: [{ name: '', phone: '010-1234-5678' }] })).status, 400, '이름 없음');
  assert.equal((await post('/api/groups', { ...good, members: [{ name: 'B', phone: '1234' }] })).status, 400, '전화번호 너무 짧음');
  assert.equal((await post('/api/groups', { ...good, fields: [{ ...good.fields[0], type: 'date' }] })).status, 400, '서명 칸 없음');
  assert.equal((await post('/api/groups', { ...good, members: Array.from({ length: 501 }, (_, i) => ({ name: `n${i}`, phone: '010-1234-5678' })) })).status, 400, '한 번에 500명 초과');
});

// ───── 실제 SMTP 서버로 메일 발송 (가짜 transport가 아닌 nodemailer 실제 경로) ─────
test('실제 SMTP로 테스트 메일·서명 요청 메일 발송', async () => {
  const { SMTPServer } = require('smtp-server');
  const { simpleParser } = require('mailparser');
  const received = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onRcptTo(address, session, cb) {
      if (address.address.startsWith('nobody@')) return cb(Object.assign(new Error('550 No such user'), { responseCode: 550 }));
      return cb();
    },
    onData(stream, session, cb) {
      simpleParser(stream).then((m) => { received.push(m); cb(); }, cb);
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const smtpPort = smtp.server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-smtp-'));
  const s = createApp({ dataDir: dir, adminPassword: ADMIN_PASSWORD }).listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
  const admin = { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', Cookie: cookieOf(login) };
  const api = async (p, body) => fetch(url + p, body ? { method: 'POST', headers: admin, body: JSON.stringify(body) } : { headers: admin });

  try {
    assert.equal((await api('/api/settings/test-mail', { to: 'me@example.com' })).status, 400, '설정 전에는 발송 불가');
    const saved = await (await api('/api/settings', {
      publicUrl: 'http://192.168.0.50:3300',
      mail: { preset: 'custom', host: '127.0.0.1', port: smtpPort, security: 'none', user: '', pass: 'secret-pass', fromName: '코디세이 운영팀', fromEmail: 'noreply@example.com' },
    })).json();
    assert.equal(saved.mail.hasPassword, true);
    assert.ok(!JSON.stringify(saved).includes('secret-pass'), '비밀번호는 응답에 없음');
    assert.ok(!JSON.stringify(await (await api('/api/settings')).json()).includes('secret-pass'));
    assert.equal((await api('/api/settings', { mail: { preset: 'custom', host: 'bad host!', port: 25, security: 'none', fromEmail: 'a@b.c' } })).status, 400);

    const t = await api('/api/settings/test-mail', { to: 'me@example.com' });
    assert.equal(t.status, 200, await t.clone().text());
    assert.equal(received[0].subject, '[e서명] 테스트 메일');
    assert.equal(received[0].from.value[0].name, '코디세이 운영팀');

    const bad = await api('/api/settings/test-mail', { to: 'nobody@example.com' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /받는 사람/);

    const g = await (await api('/api/groups', {
      title: '안전교육 이수 확인서',
      pdfBase64: (await samplePdf()).toString('base64'),
      fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
      members: [{ name: '홍길동', phone: '010-1234-5678', email: 'hong@example.com' }, { name: '임꺽정', phone: '010-2345-6789', email: 'lim@example.com' }],
    })).json();
    assert.equal(g.link.reach, 'private');
    assert.equal((await api(`/api/groups/${g.id}/send`, { scope: 'unsent' })).status, 202);
    for (let i = 0; i < 200 && received.length < 3; i += 1) await new Promise((r) => setTimeout(r, 25));
    const hong = received.find((m) => m.to.value[0].address === 'hong@example.com');
    assert.equal(hong.subject, '[서명 요청] 안전교육 이수 확인서');
    assert.equal(hong.to.value[0].name, '홍길동');
    const link = g.members.find((m) => m.name === '홍길동').signLink;
    assert.ok(link.startsWith('http://192.168.0.50:3300/sign.html?t='));
    assert.ok(hong.text.includes(link) && hong.html.includes(link), '받은 메일(디코딩 후)에 본인 링크');
    assert.ok(hong.html.includes('홍길동'));
  } finally {
    s.close();
    await new Promise((r) => smtp.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('서명 링크 주소: PUBLIC_URL / LAN 모드', async () => {
  const run = async (opts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-url-'));
    const s = createApp({ dataDir: dir, adminPassword: ADMIN_PASSWORD, ...opts }).listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    const info = await (await fetch(`${url}/api/server-info`, { headers: { Cookie: cookieOf(login) } })).json();
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return info;
  };
  const fixed = await run({ publicUrl: 'https://sign.example.com/' });
  assert.equal(fixed.publicBaseUrl, 'https://sign.example.com');
  assert.equal(fixed.reach, 'public');
  const lanInfo = await run({ lan: true, port: 4567 });
  assert.equal(lanInfo.lanMode, true);
  const ip = lanAddresses()[0];
  if (ip) assert.equal(lanInfo.publicBaseUrl, `http://${ip}:4567`);
});

test('본인 확인 비교 규칙', () => {
  const { normalizePhone, normalizeName, reachability } = require('../server');
  assert.equal(normalizePhone('+82 10-1234-5678'), '01012345678');
  assert.equal(normalizePhone('010.1234.5678'), '01012345678');
  assert.equal(normalizeName(' 홍 길동 '), normalizeName('홍길동'));
  assert.equal(normalizeName('Kim Minsu'), normalizeName('kimminsu'));
  assert.equal(reachability('http://localhost:3300'), 'local');
  assert.equal(reachability('http://192.168.0.5:3300'), 'private');
  assert.equal(reachability('https://abc.trycloudflare.com'), 'public');
});

test('명단 PDF 연락처 가리기: +82·지역번호 형식도 010-****-1234 꼴로', () => {
  const { maskPhone } = require('../lib/roster');
  assert.equal(maskPhone('010-1234-5678'), '010-****-5678');
  assert.equal(maskPhone('+82 10 2222 3333'), '010-****-3333');
  assert.equal(maskPhone('+82-10-2222-3333'), '010-****-3333');
  assert.equal(maskPhone('02-123-4567'), '02-****-4567');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone('1234'), '***');
});
