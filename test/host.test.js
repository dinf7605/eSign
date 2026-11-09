'use strict';
// DNS 리바인딩 차단: 관리자 API는 이 PC·LAN에서 쓰는 주소(Host)로 들어온 요청만 받는다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../server');

async function withServer(options, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-host-'));
  const server = createApp({ dataDir, reminderIntervalMs: 0, ...options }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  // fetch는 Host 헤더를 바꿀 수 없으므로 http.request로 보낸다
  const call = (url, { method = 'GET', host = `127.0.0.1:${port}`, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port, path: url, method,
      headers: { Host: host, 'X-Requested-With': 'esign', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    await fn(call, port);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('낯선 도메인(Host)으로 들어온 처음 비밀번호 설정은 거절 (DNS 리바인딩)', () => withServer({}, async (call, port) => {
  const res = await call('/api/auth/setup', { method: 'POST', host: `attacker.example:${port}`, body: { password: 'attacker-pass-123' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'bad_host');
  const status = await call('/api/auth/status');
  assert.equal(status.body.setupRequired, true, '비밀번호가 설정되지 않아야 함');
}));

test('Host에 userinfo·이상한 문자를 섞어도 거절', () => withServer({}, async (call) => {
  for (const host of ['evil.example@127.0.0.1', 'evil.example.', 'evil.example:80:80']) {
    assert.equal((await call('/api/auth/status', { host })).status, 403, host);
  }
}));

test('localhost·IP 주소·이 PC 이름·설정한 서명 링크 주소는 허용', () => withServer({ publicUrl: 'https://sign.example.com' }, async (call, port) => {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.0.10:${port}`, os.hostname(), 'sign.example.com', 'LOCALHOST'];
  for (const host of hosts) {
    assert.equal((await call('/api/auth/status', { host })).status, 200, host);
  }
}));

test('서명자·검증 API는 Host와 상관없이 그대로 동작', () => withServer({}, async (call) => {
  const res = await call('/api/verify', { method: 'POST', host: 'anything.example', body: { hash: 'a'.repeat(64) } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { match: null });
}));
