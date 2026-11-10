'use strict';
// LAN 모드(같은 Wi-Fi)에서 관리자 기능은 서버를 켠 PC에서만
//  - http:// 라 같은 Wi-Fi의 다른 사람이 관리자 비밀번호·로그인 쿠키를 엿볼 수 있으므로
//    다른 기기에서는 로그인·관리자 API·처음 비밀번호 설정을 모두 막는다 (서명·검증은 그대로)
//  - 서버 PC가 자기 LAN 주소(http://192.168.x.x)로 열어도 관리자 화면은 쓸 수 있다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp, lanAddresses } = require('../server');

const PASSWORD = 'lan-admin-test-pw';
const LAN_IP = lanAddresses()[0];
const skip = !LAN_IP && '이 PC에 LAN(IPv4) 주소가 없음';

/**
 * 0.0.0.0에서 듣는 서버에 이 PC의 LAN 주소로 접속한다 → 서버가 보는 접속자 주소도 LAN 주소.
 * serverAddresses를 비워 두면 "이 LAN 주소는 다른 기기"인 것처럼 시험할 수 있다.
 */
async function withLanServer(options, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-lan-'));
  const server = createApp({ dataDir, lan: true, reminderIntervalMs: 0, ...options }).listen(0, '0.0.0.0');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const call = (url, { method = 'GET', body, host = LAN_IP, cookie, redirect = 'follow' } = {}) => fetch(`http://${host}:${port}${url}`, {
    method,
    redirect,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'esign',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    await fn(call);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const OTHER_DEVICE = { serverAddresses: () => [] }; // LAN 주소를 "다른 기기"로 취급

test('같은 Wi-Fi의 다른 기기에서는 관리자 로그인·API가 막힌다', { skip }, () => withLanServer({ adminPassword: PASSWORD, ...OTHER_DEVICE }, async (call) => {
  const login = await call('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(login.status, 403, '맞는 비밀번호여도 다른 기기에서는 로그인 불가');
  assert.equal((await login.json()).code, 'admin_local_only');
  assert.equal(login.headers.get('set-cookie'), null, '로그인 쿠키 발급 금지');

  for (const p of ['/api/auth/status', '/api/settings', '/api/groups', '/api/documents', '/api/templates', '/api/retention', '/api/server-info', '/API/Documents']) {
    const r = await call(p);
    assert.equal(r.status, 403, p);
    assert.equal((await r.json()).code, 'admin_local_only', p);
  }
  for (const p of ['/', '/index.html', '/login.html', '/settings.html', '/group.html', '/Settings.html.']) {
    const r = await call(p, { redirect: 'manual' });
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/verify.html', p);
  }
  // 서명·검증은 그대로
  assert.equal((await call('/sign.html')).status, 200);
  assert.equal((await call('/verify.html')).status, 200);
  assert.equal((await call('/api/seal')).status, 200);
  assert.equal((await call('/api/sign/not-a-token')).status, 404);
}));

test('다른 기기에서 훔친 로그인 쿠키로도 관리자 API를 쓸 수 없다', { skip }, () => withLanServer({ adminPassword: PASSWORD, ...OTHER_DEVICE }, async (call) => {
  const login = await call('/api/auth/login', { method: 'POST', host: '127.0.0.1', body: { password: PASSWORD } });
  assert.equal(login.status, 200, '서버 PC에서는 로그인 가능');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/groups', { host: '127.0.0.1', cookie })).status, 200);
  assert.equal((await call('/api/groups', { cookie })).status, 403, '같은 쿠키라도 다른 기기에서는 거절');
}));

test('처음 비밀번호 설정도 다른 기기에서는 불가', { skip }, () => withLanServer(OTHER_DEVICE, async (call) => {
  const r = await call('/api/auth/setup', { method: 'POST', body: { password: 'hacker-password' } });
  assert.equal(r.status, 403);
  assert.equal((await call('/api/auth/setup', { method: 'POST', host: '127.0.0.1', body: { password: 'owner-password' } })).status, 200, '서버 PC에서는 가능');
}));

test('서버 PC가 자기 LAN 주소로 열면 관리자 기능을 그대로 쓴다', { skip }, () => withLanServer({ adminPassword: PASSWORD }, async (call) => {
  const login = await call('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/groups', { cookie })).status, 200);
  assert.equal((await call('/settings.html', { redirect: 'manual' })).status, 200);
}));
