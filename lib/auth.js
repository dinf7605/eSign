'use strict';
// 관리자(요청자) 로그인.
//  - 비밀번호는 scrypt 해시로 data/admin.json에 저장 (원문 저장 안 함)
//  - 처음 비밀번호 설정은 서버 PC(localhost)에서만 가능 → 같은 Wi-Fi의 다른 사람이 먼저 설정하는 것 방지
//  - 세션은 메모리에만 보관 (서버를 다시 켜면 다시 로그인)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'esign_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return {
    salt: salt.toString('hex'),
    hash: crypto.scryptSync(password, salt, 32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
}

const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function createAuth({ dataDir, adminPassword }) {
  const file = path.join(dataDir, 'admin.json');
  let cred = null;
  if (adminPassword) cred = hashPassword(adminPassword);
  else if (fs.existsSync(file)) cred = JSON.parse(fs.readFileSync(file, 'utf8'));

  const sessions = new Map(); // token → 만료 시각
  const failures = new Map(); // ip → { count, until }

  function passwordMatches(password) {
    if (!cred || typeof password !== 'string') return false;
    const actual = crypto.scryptSync(password, Buffer.from(cred.salt, 'hex'), 32);
    return crypto.timingSafeEqual(actual, Buffer.from(cred.hash, 'hex'));
  }

  function currentSession(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const expires = sessions.get(token);
    if (!expires || expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return token;
  }

  function startSession(req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${req.secure ? '; Secure' : ''}`);
  }

  // 다른 사이트에서 몰래 보내는 요청(CSRF) 차단: 우리 화면은 항상 이 헤더를 붙인다
  const requireAppHeader = (req, res, next) => {
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'esign') {
      return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
    }
    return next();
  };

  const router = express.Router();
  router.use(requireAppHeader);

  router.get('/status', (req, res) => {
    res.json({ loggedIn: Boolean(currentSession(req)), setupRequired: !cred, canSetup: !cred && isLoopback(req.ip) });
  });

  router.post('/setup', (req, res) => {
    if (cred) return res.status(409).json({ error: '이미 비밀번호가 설정되어 있습니다.' });
    if (!isLoopback(req.ip)) return res.status(403).json({ error: '처음 비밀번호 설정은 서버를 실행한 PC에서만 할 수 있습니다.' });
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: '비밀번호는 8자 이상으로 정해 주세요.' });
    }
    cred = hashPassword(password);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cred, null, 2), { mode: 0o600 });
    startSession(req, res);
    return res.json({ ok: true });
  });

  router.post('/login', (req, res) => {
    const f = failures.get(req.ip);
    if (f && f.until > Date.now()) {
      return res.status(429).json({ error: `비밀번호를 여러 번 틀렸습니다. ${Math.ceil((f.until - Date.now()) / 1000)}초 뒤에 다시 시도해 주세요.` });
    }
    if (!cred) return res.status(409).json({ error: '먼저 관리자 비밀번호를 설정해 주세요.' });
    if (!passwordMatches(req.body?.password)) {
      const count = (f?.count || 0) + 1;
      failures.set(req.ip, { count: count >= MAX_FAILURES ? 0 : count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }
    failures.delete(req.ip);
    startSession(req, res);
    return res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = currentSession(req);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  function requireAdmin(req, res, next) {
    if (!currentSession(req)) return res.status(401).json({ error: '로그인이 필요합니다.', code: 'auth' });
    return requireAppHeader(req, res, next);
  }

  return { router, requireAdmin };
}

module.exports = { createAuth, readCookie };
