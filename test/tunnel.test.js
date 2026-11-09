'use strict';
// 집에서 서명 (인터넷 공개 터널)
//  - cloudflared 출력에서 주소 찾기, 가짜 cloudflared로 터널 켜기/끄기
//  - 터널로 들어온 요청: 관리자 화면·API 차단, 서명·검증만 허용, 실제 접속자 IP 기록, Secure 쿠키
//  - 서명 링크가 터널 주소로 만들어짐
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { parseTunnelUrl, startTunnel, findCloudflared } = require('../lib/tunnel');
const { createApp } = require('../server');

const TUNNEL_URL = 'https://quiet-river-1234.trycloudflare.com';
const VISITOR_IP = '203.0.113.7';

test('cloudflared 출력에서 공개 주소 찾기', () => {
  assert.equal(parseTunnelUrl(`2026-11-09T13:00:00Z INF |  ${TUNNEL_URL}                 |`), TUNNEL_URL);
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(parseTunnelUrl('https://evil.example.com/?x=trycloudflare.com'), null);
});

test('cloudflared 위치: ESIGN_CLOUDFLARED가 없는 파일이면 null', () => {
  assert.equal(findCloudflared({ ESIGN_CLOUDFLARED: path.join(os.tmpdir(), 'no-such-cloudflared.exe') }), null);
  assert.equal(findCloudflared({ ESIGN_CLOUDFLARED: process.execPath }), process.execPath);
});

test('가짜 cloudflared로 터널 켜기 → 주소 알림 → 끄기', async () => {
  const script = `process.stderr.write('INF Requesting new quick Tunnel\\n'); setTimeout(() => process.stderr.write('INF | ${TUNNEL_URL} |\\n'), 50); setInterval(() => {}, 1000);`;
  const urls = [];
  const t = startTunnel({ port: 1, command: [process.execPath, '-e', script], onUrl: (u) => urls.push(u), log: { warn() {} } });
  assert.equal(t.state().status, 'starting');
  for (let i = 0; i < 100 && t.state().status !== 'up'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.state(), { status: 'up', url: TUNNEL_URL, error: null });
  assert.deepEqual(urls, [TUNNEL_URL]);
  t.stop();
});

test('cloudflared가 죽으면 다시 켠다', async () => {
  const urls = [];
  const script = `process.stderr.write('INF | ${TUNNEL_URL} |\\n'); setTimeout(() => process.exit(1), 50);`;
  const t = startTunnel({ port: 1, command: [process.execPath, '-e', script], onUrl: (u) => urls.push(u), restartDelayMs: 30, log: { warn() {} } });
  for (let i = 0; i < 150 && urls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
  t.stop();
  assert.ok(urls.length >= 2, '끊긴 뒤 다시 연결');
});

// ───── 서버: 터널로 들어온 요청 ─────

const UP = () => ({ status: 'up', url: TUNNEL_URL, error: null });

async function withServer(options, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-tunnel-'));
  const server = createApp({ dataDir, ...options }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = (url, { method = 'GET', body, tunnel = false, redirect = 'follow' } = {}) => fetch(base + url, {
    method,
    redirect,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'esign',
      ...(cookie && !tunnel ? { Cookie: cookie } : {}),
      // cloudflared가 붙이는 헤더 (Cloudflare가 실제 접속자 IP로 덮어씀)
      ...(tunnel ? { 'CF-Connecting-IP': VISITOR_IP, 'X-Forwarded-Proto': 'https' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = async (password) => {
    const r = await call('/api/auth/login', { method: 'POST', body: { password } });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  };
  try {
    await fn({ call, login });
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function blankPdfBase64() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save()).toString('base64');
}

test('터널로는 관리자 화면·API가 막히고 서명·검증만 열린다', async () => {
  await withServer({ adminPassword: 'tunnel-test-pw', tunnel: UP }, async ({ call, login }) => {
    for (const p of ['/api/auth/status', '/api/settings', '/api/groups', '/api/documents', '/api/server-info']) {
      const r = await call(p, { tunnel: true });
      assert.equal(r.status, 403, p);
      assert.equal((await r.json()).code, 'admin_local_only');
    }
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'tunnel-test-pw' }, tunnel: true })).status, 403, '인터넷에서 로그인 불가');
    for (const p of ['/', '/index.html', '/settings.html', '/login.html', '/group.html', '/new.html', '/doc.html']) {
      const r = await call(p, { tunnel: true, redirect: 'manual' });
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), '/verify.html');
    }
    assert.equal((await call('/verify.html', { tunnel: true })).status, 200);
    assert.equal((await call('/sign.html', { tunnel: true })).status, 200);
    assert.equal((await call('/api/seal', { tunnel: true })).status, 200);
    await login('tunnel-test-pw'); // 이 PC에서는 그대로 로그인 가능
  });
});

test('처음 비밀번호 설정은 터널로 할 수 없다', async () => {
  await withServer({ tunnel: UP }, async ({ call }) => {
    assert.equal((await call('/api/auth/setup', { method: 'POST', body: { password: 'hacker-password' }, tunnel: true })).status, 403);
    assert.equal((await call('/api/auth/setup', { method: 'POST', body: { password: 'owner-password' } })).status, 200, '이 PC에서는 가능');
  });
});

test('서명 링크는 터널 주소로 나가고, 터널로 열면 실제 접속자 IP가 기록된다', async () => {
  await withServer({ adminPassword: 'tunnel-test-pw', tunnel: UP }, async ({ call, login }) => {
    await login('tunnel-test-pw');
    const settings = await (await call('/api/settings')).json();
    assert.equal(settings.current.publicBaseUrl, TUNNEL_URL);
    assert.equal(settings.current.reach, 'public');
    assert.equal(settings.current.temporary, true);

    const doc = await (await call('/api/documents', {
      method: 'POST',
      body: {
        title: '집에서 서명',
        fileName: 'a.pdf',
        pdfBase64: await blankPdfBase64(),
        signers: [{ name: '홍길동' }],
        fields: [{ signerIndex: 0, page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 }],
      },
    })).json();
    assert.ok(doc.signers[0].signLink.startsWith(`${TUNNEL_URL}/sign.html?t=`), doc.signers[0].signLink);

    const t = new URL(doc.signers[0].signLink).searchParams.get('t');
    assert.equal((await call(`/api/sign/${t}`, { tunnel: true })).status, 200);
    const after = await (await call(`/api/documents/${doc.id}`)).json();
    assert.equal(after.events.find((e) => e.type === 'viewed').ip, VISITOR_IP, '터널 뒤 실제 접속자 IP');
  });
});

test('교육생 일괄: 링크가 임시 주소로 표시되고, 본인 확인 쿠키는 Secure', async () => {
  await withServer({ adminPassword: 'tunnel-test-pw', tunnel: UP }, async ({ call, login }) => {
    await login('tunnel-test-pw');
    const created = await call('/api/groups', {
      method: 'POST',
      body: {
        title: '집에서 서명',
        fileName: 'a.pdf',
        pdfBase64: await blankPdfBase64(),
        requireVerification: true,
        members: [{ name: '홍길동', phone: '010-1111-2222', email: 'hong@example.com' }],
        fields: [{ type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 }],
      },
    });
    const group = await created.json();
    assert.equal(created.status, 201, JSON.stringify(group));
    const g = await (await call(`/api/groups/${group.id}`)).json();
    assert.equal(g.link.temporary, true);
    assert.equal(g.link.base, TUNNEL_URL);
    assert.ok(g.members[0].signLink.startsWith(TUNNEL_URL), g.members[0].signLink);
    const t = new URL(g.members[0].signLink).searchParams.get('t');
    const ok = await call(`/api/sign/${t}/verify`, { method: 'POST', body: { name: '홍길동', phone: '01011112222' }, tunnel: true });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /; Secure/);
  });
});

test('터널이 아직 준비 안 됐으면 링크 주소는 이 PC 전용(local) → 메일 발송이 막힘', async () => {
  await withServer({ adminPassword: 'tunnel-test-pw', tunnel: () => ({ status: 'starting', url: null, error: null }) }, async ({ call, login }) => {
    await login('tunnel-test-pw');
    const info = await (await call('/api/server-info')).json();
    assert.equal(info.reach, 'local');
    assert.equal(info.tunnel.status, 'starting');
  });
});
