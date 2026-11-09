'use strict';
// 서명 기한 · 자동 다시 알림 (시계를 바꿔 가며 시험)
//  - 기한 입력 검사, 메일에 기한 표시
//  - 기한 N일 전: 요청 메일을 받았지만 미서명인 사람에게만 한 번씩 다시 알림
//  - 서버가 꺼져 밀린 알림은 한 번만
//  - 기한이 지나면 미서명자는 서명 불가(이미 서명한 사람은 완료본 받기 가능), 기한 연장하면 다시 가능
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../server');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'deadline-test-pw';
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
const sentMails = [];
// 요청·다시 알림 메일만 센다 (서명 완료본 메일은 fields.test.js에서 확인)
const transport = { async sendMail(m) { if (!m.subject.startsWith('[서명 완료]')) sentMails.push(m); return { messageId: `<${sentMails.length}@t>` }; } };

const call = (url, { method = 'GET', body } = {}) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const post = (url, body) => call(url, { method: 'POST', body });
const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (link) => new URL(link).searchParams.get('t');
const iso = (ms) => new Date(ms).toISOString();

async function pdfBase64() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save()).toString('base64');
}

async function newGroup(extra) {
  const r = await json(await post('/api/groups', {
    title: '안전교육 서약서',
    fileName: 'a.pdf',
    pdfBase64: await pdfBase64(),
    requireVerification: false,
    members: [{ name: '가', email: 'a@example.com' }, { name: '나', email: 'b@example.com' }, { name: '다', email: 'c@example.com' }, { name: '라' }],
    fields: [{ type: 'signature', page: 1, x: 0.6, y: 0.85, w: 0.25, h: 0.06 }],
    ...extra,
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function waitMail(groupId) {
  for (let i = 0; i < 200; i += 1) {
    const g = await (await call(`/api/groups/${groupId}`)).json();
    if (!g.mail.sending?.running) return g;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('메일 발송이 끝나지 않음');
}

async function sign(member) {
  const t = tokenOf(member.signLink);
  const view = await json(await call(`/api/sign/${t}`));
  if (view.status !== 200) return view;
  const sigs = Object.fromEntries(view.body.fields.map((f) => [f.id, PNG]));
  return json(await post(`/api/sign/${t}`, { consent: true, signatures: sigs }));
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-deadline-'));
  app = createApp({
    dataDir, adminPassword: PASSWORD, mailTransport: transport, publicUrl: 'https://sign.example.test', clock: () => nowMs, reminderIntervalMs: 0,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await post('/api/auth/login', { password: PASSWORD })).headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('기한 입력 검사', async () => {
  const bad = async (extra) => (await post('/api/groups', {
    title: 't', fileName: 'a.pdf', pdfBase64: await pdfBase64(), requireVerification: false,
    members: [{ name: 'A' }], fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], ...extra,
  })).status;
  assert.equal(await bad({ deadline: iso(nowMs - 1000) }), 400, '지난 시각');
  assert.equal(await bad({ deadline: iso(nowMs + 400 * DAY) }), 400, '1년 넘음');
  assert.equal(await bad({ deadline: '다음 주' }), 400, '날짜 아님');
  assert.equal(await bad({ deadline: iso(nowMs + 5 * DAY), autoRemind: [4] }), 400, '고를 수 없는 날');
  assert.equal(await bad({ deadline: iso(nowMs + 5 * DAY), autoRemind: '3' }), 400, '배열 아님');
  assert.equal(await bad({}), 201, '기한 없음도 가능');
});

test('기한 N일 전 자동 다시 알림 → 기한 지나면 서명 불가 → 연장하면 다시 가능', async () => {
  const deadline = nowMs + 4 * DAY;
  const g = await newGroup({ deadline: iso(deadline), autoRemind: [1, 3, 3] });
  assert.equal(g.deadline, iso(deadline));
  assert.deepEqual(g.autoRemind, [3, 1], '중복 제거, 큰 날부터');
  assert.equal(g.nextReminderAt, iso(deadline - 3 * DAY));

  // 첫 요청 메일: 기한이 적혀 있음. '다'는 아직 안 보냄(→ 자동 알림 대상 아님)
  const before = sentMails.length;
  for (const m of g.members.slice(0, 2)) {
    assert.equal((await post(`/api/groups/${g.id}/send`, { scope: 'one', docId: m.docId })).status, 202);
    await waitMail(g.id);
  }
  const first = sentMails.slice(before);
  assert.equal(first.length, 2);
  assert.match(first[0].text, /서명 기한: .*까지/);
  assert.match(first[0].html, /서명 기한/);

  // '가'는 서명함 → 알림 대상 아님
  assert.equal((await sign(g.members[0])).status, 200);

  // 아직 3일 전이 안 됨
  await app.runReminders();
  assert.equal(sentMails.length, before + 2, '아직 알림 시각 전');

  // 3일 전이 됨 → '나'에게만 다시 알림
  nowMs = deadline - 3 * DAY + 60 * 1000;
  await app.runReminders();
  await waitMail(g.id);
  let auto = sentMails.slice(before + 2);
  assert.deepEqual(auto.map((m) => m.to.address), ['b@example.com']);
  assert.match(auto[0].subject, /^\[다시 알림\]/);
  await app.runReminders();
  assert.equal(sentMails.length, before + 3, '같은 알림은 한 번만');
  let view = await (await call(`/api/groups/${g.id}`)).json();
  assert.equal(view.reminders.length, 1);
  assert.equal(view.reminders[0].days, 3);
  assert.equal(view.reminders[0].count, 1);
  assert.equal(view.nextReminderAt, iso(deadline - 1 * DAY));

  // 1일 전
  nowMs = deadline - 1 * DAY + 60 * 1000;
  await app.runReminders();
  await waitMail(g.id);
  auto = sentMails.slice(before + 3);
  assert.deepEqual(auto.map((m) => m.to.address), ['b@example.com']);
  view = await (await call(`/api/groups/${g.id}`)).json();
  assert.equal(view.nextReminderAt, null);

  // 기한 지남 → 미서명자는 서명 불가, 서명한 사람은 완료본 받기 가능, 알림 없음
  nowMs = deadline + 60 * 1000;
  const late = await sign(g.members[1]);
  assert.equal(late.status, 410);
  assert.equal(late.body.code, 'expired');
  assert.match(late.body.error, /서명 기한\(.+\)이 지났습니다/);
  assert.equal((await call(`/api/sign/${tokenOf(g.members[0].signLink)}`)).status, 200, '이미 서명한 사람은 열람 가능');
  assert.equal((await call(`/api/sign/${tokenOf(g.members[0].signLink)}/completed.pdf`)).status, 200);
  view = await (await call(`/api/groups/${g.id}`)).json();
  assert.equal(view.expired, true);
  const list = await (await call('/api/groups')).json();
  assert.equal(list.find((x) => x.id === g.id).expired, true);
  const count = sentMails.length;
  await app.runReminders();
  assert.equal(sentMails.length, count, '기한 지나면 알림 없음');

  // 기한 연장 → 다시 서명 가능, 교육생 문서에도 새 기한
  const newDeadline = nowMs + 2 * DAY;
  const extended = await json(await post(`/api/groups/${g.id}/deadline`, { deadline: iso(newDeadline), autoRemind: [3, 1] }));
  assert.equal(extended.status, 200, JSON.stringify(extended.body));
  assert.equal(extended.body.expired, false);
  assert.equal(extended.body.nextReminderAt, iso(newDeadline - DAY), '이미 지난 3일 전 알림은 건너뜀');
  const signView = await (await call(`/api/sign/${tokenOf(g.members[1].signLink)}`)).json();
  assert.equal(signView.deadline, iso(newDeadline));
  assert.equal((await sign(g.members[1])).status, 200);

  // 기한 없애기
  const cleared = await json(await post(`/api/groups/${g.id}/deadline`, { deadline: null }));
  assert.equal(cleared.body.deadline, null);
  assert.deepEqual(cleared.body.autoRemind, []);
  assert.equal((await call(`/api/sign/${tokenOf(g.members[2].signLink)}`).then((r) => r.json())).deadline, null);
});

test('서버가 꺼져 밀린 알림은 한 번만 보낸다', async () => {
  const deadline = nowMs + 6 * DAY;
  const g = await newGroup({ deadline: iso(deadline), autoRemind: [5, 3, 1] });
  await post(`/api/groups/${g.id}/send`, { scope: 'unsent' });
  await waitMail(g.id);
  const before = sentMails.length;
  nowMs = deadline - 1 * DAY + 1000; // 5일 전·3일 전·1일 전이 모두 지남
  await app.runReminders();
  await waitMail(g.id);
  assert.equal(sentMails.length - before, 3, '3명에게 한 번씩');
  const view = await (await call(`/api/groups/${g.id}`)).json();
  assert.equal(view.reminders.length, 1);
  assert.equal(view.nextReminderAt, null);
  await app.runReminders();
  assert.equal(sentMails.length - before, 3);
});

test('링크 주소가 이 PC 전용이면 자동 알림을 보내지 않고 이유를 남긴다', async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-deadline-local-'));
  let t = Date.now();
  const localApp = createApp({ dataDir: localDir, adminPassword: PASSWORD, mailTransport: transport, clock: () => t, reminderIntervalMs: 0 });
  const s = localApp.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const login = await fetch(`${b}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'esign' }, body: JSON.stringify({ password: PASSWORD }) });
    const c = login.headers.get('set-cookie').split(';')[0];
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'esign', Cookie: c };
    const deadline = t + 2 * DAY;
    const g = await (await fetch(`${b}/api/groups`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        title: 't', fileName: 'a.pdf', pdfBase64: await pdfBase64(), requireVerification: false,
        members: [{ name: 'A', email: 'x@example.com' }], fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
        deadline: iso(deadline), autoRemind: [1],
      }),
    })).json();
    t = deadline - DAY + 1000;
    await localApp.runReminders();
    const view = await (await fetch(`${b}/api/groups/${g.id}`, { headers: h })).json();
    assert.match(view.reminderError, /이 PC 전용/);
    assert.equal(view.reminders.length, 0);
    assert.ok(view.nextReminderAt, '보내지 못한 알림은 남아 있음');
  } finally {
    s.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});
