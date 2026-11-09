'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const { createStore } = require('./lib/store');
const { buildCompletedPdf } = require('./lib/finalize');
const { loadOrCreateSeal } = require('./lib/seal-cert');
const { verifyPdfSignatures } = require('./lib/cades');
const { createAuth, readCookie } = require('./lib/auth');
const { buildRosterPdf, buildRosterXlsx } = require('./lib/roster');
const { createZip, safeFileName } = require('./lib/zip');
const { createSettings, MAIL_PRESETS } = require('./lib/settings');
const { createMailer, friendlyMailError, signRequestMail, completedCopyMail } = require('./lib/mailer');
const { normalizePhone } = require('./lib/phone');
const { requestTimestamp, verifyTimestampToken } = require('./lib/tsa');

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_SIGNERS = 10;
const MAX_FIELDS = 100;
const MAX_MEMBERS_PER_REQUEST = 500;
const MAX_MEMBERS_PER_GROUP = 1000;
const FIELD_TYPES = ['signature', 'name', 'date', 'checkbox', 'text'];
/** 서명자가 직접 체크·입력하는 칸 */
const INPUT_TYPES = ['checkbox', 'text'];
const MAX_TEXT_VALUE = 200;
const DEFAULT_LABEL = { checkbox: '체크 항목', text: '입력란' };
const CONSENT_TEXT = '본인은 위 문서의 내용을 확인하였으며, 이 전자서명이 본인의 서명임에 동의합니다.';
const VERIFY_MAX_FAILURES = 5;
const VERIFY_LOCK_MS = 15 * 60 * 1000;
const SIGNER_SESSION_MS = 2 * 60 * 60 * 1000;
const SIGNER_COOKIE = 'esign_sv';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => new Date().toISOString();
const typeOf = (field) => field.type || 'signature';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, { field, max, required = true }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) fail(400, `${field}을(를) 입력해 주세요.`);
  if (s.length > max) fail(400, `${field}은(는) ${max}자 이하로 입력해 주세요.`);
  return s;
}

const isFraction = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function requestMeta(req) {
  return { ip: req.clientIp || req.ip || '', userAgent: String(req.get('user-agent') || '').slice(0, 300) };
}

/** 본인 확인용 비교: 공백 무시, 대소문자 무시 */
const normalizeName = (s) => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

const isLoopbackAddress = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

/** 이 PC의 내부망 IPv4 주소 (교육생 휴대폰이 같은 Wi-Fi에서 접속할 주소) */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

/** 링크 주소가 어디서 열 수 있는지: local(이 PC만) / private(같은 망) / public */
function reachability(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return 'local'; }
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.localhost')) return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host.endsWith('.local')) return 'private';
  return 'public';
}

// ───────────── 입력 검사 ─────────────

async function parsePdf(body) {
  if (typeof body.pdfBase64 !== 'string') fail(400, 'PDF 파일을 올려 주세요.');
  const bytes = Buffer.from(body.pdfBase64, 'base64');
  if (bytes.length === 0) fail(400, 'PDF 파일이 비어 있습니다.');
  if (bytes.length > MAX_PDF_BYTES) fail(413, 'PDF는 15MB 이하만 올릴 수 있습니다.');
  if (!bytes.subarray(0, 1024).includes('%PDF-')) fail(400, 'PDF 파일이 아닙니다.');
  let pageCount;
  try {
    pageCount = (await PDFDocument.load(bytes)).getPageCount();
  } catch (err) {
    if (/encrypt/i.test(err.message)) fail(400, '암호가 걸린 PDF는 사용할 수 없습니다.');
    fail(400, 'PDF 파일을 읽을 수 없습니다. 손상된 파일인지 확인해 주세요.');
  }
  if (pageCount < 1) fail(400, '페이지가 없는 PDF입니다.');
  return { bytes, pageCount };
}

function parsePerson(p, label, { requirePhone = false } = {}) {
  const email = cleanText(p?.email, { field: `${label} 이메일`, max: 100, required: false });
  if (email && !isEmail(email)) fail(400, `${label} 이메일 형식이 올바르지 않습니다.`);
  const phone = cleanText(p?.phone, { field: `${label} 연락처`, max: 30, required: false });
  if (phone && !/^[0-9+\-()\s]+$/.test(phone)) fail(400, `${label} 연락처 형식이 올바르지 않습니다.`);
  if (requirePhone && normalizePhone(phone).length < 9) fail(400, `${label} 전화번호가 없거나 짧습니다. (본인 확인에 필요)`);
  return {
    name: cleanText(p?.name, { field: `${label} 이름`, max: 50 }),
    org: cleanText(p?.org, { field: `${label} 소속`, max: 50, required: false }),
    phone,
    email,
  };
}

/** 서명자가 보낸 체크·입력값을 검사한다. 필수 항목이 비면 거절. */
function parseAnswers(inputFields, values) {
  return inputFields.map((field) => {
    const raw = values[field.id];
    if (field.type === 'checkbox') {
      if (raw !== undefined && typeof raw !== 'boolean') fail(400, '체크 항목 값이 올바르지 않습니다.');
      const value = raw === true;
      if (field.required && !value) fail(400, `필수 항목 "${field.label}"에 체크해 주세요.`);
      return { field, value };
    }
    if (raw !== undefined && typeof raw !== 'string') fail(400, '입력값 형식이 올바르지 않습니다.');
    // eslint-disable-next-line no-control-regex
    const value = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (value.length > MAX_TEXT_VALUE) fail(400, `"${field.label}"은(는) ${MAX_TEXT_VALUE}자 이하로 입력해 주세요.`);
    if (field.required && !value) fail(400, `"${field.label}" 칸을 입력해 주세요.`);
    return { field, value };
  });
}

function parseFields(fieldsIn, pageCount, signerCount) {
  if (!Array.isArray(fieldsIn) || fieldsIn.length < 1 || fieldsIn.length > MAX_FIELDS) fail(400, `서명란은 1~${MAX_FIELDS}개여야 합니다.`);
  return fieldsIn.map((f) => {
    const type = f?.type ?? 'signature';
    const signerIndex = signerCount === 1 ? 0 : f?.signerIndex;
    const ok = f
      && FIELD_TYPES.includes(type)
      && Number.isInteger(signerIndex) && signerIndex >= 0 && signerIndex < signerCount
      && Number.isInteger(f.page) && f.page >= 1 && f.page <= pageCount
      && [f.x, f.y, f.w, f.h].every(isFraction)
      && f.w >= 0.02 && f.h >= 0.01 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001;
    if (!ok) fail(400, '서명란 위치 정보가 올바르지 않습니다.');
    const field = { type, signerIndex, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h };
    if (INPUT_TYPES.includes(type)) {
      field.label = cleanText(f.label, { field: '항목 이름', max: 60, required: false }).replace(/\s+/g, ' ') || DEFAULT_LABEL[type];
      field.required = f.required !== false;
    }
    return field;
  });
}

function parsePublicUrl(value) {
  const s = cleanText(value, { field: '서명 링크 주소', max: 200, required: false });
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { fail(400, '서명 링크 주소는 http:// 또는 https:// 로 시작해야 합니다.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash || u.username) fail(400, '서명 링크 주소 형식이 올바르지 않습니다. (예: https://sign.example.com)');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

function parseTsaSettings(t) {
  if (!t || typeof t !== 'object') fail(400, '타임스탬프 설정이 올바르지 않습니다.');
  const url = parseTsaUrl(t.url);
  if (t.enabled && !url) fail(400, '타임스탬프 기관(TSA) 주소를 입력해 주세요.');
  return { enabled: Boolean(t.enabled), url };
}

function parseTsaUrl(value) {
  const s = cleanText(value, { field: 'TSA 주소', max: 300, required: false });
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { fail(400, 'TSA 주소는 http:// 또는 https:// 로 시작해야 합니다.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) fail(400, 'TSA 주소 형식이 올바르지 않습니다. (예: http://timestamp.digicert.com)');
  return u.href;
}

function parseMailSettings(m) {
  if (!m || typeof m !== 'object') fail(400, '메일 설정이 올바르지 않습니다.');
  const preset = MAIL_PRESETS[m.preset] ? m.preset : 'custom';
  const host = cleanText(m.host, { field: 'SMTP 서버 주소', max: 200, required: false });
  if (!host) return { preset, clearPass: true }; // 메일 설정 지우기
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) fail(400, 'SMTP 서버 주소 형식이 올바르지 않습니다.');
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'SMTP 포트는 1~65535 숫자여야 합니다.');
  const security = ['ssl', 'starttls', 'none'].includes(m.security) ? m.security : fail(400, '보안 방식을 골라 주세요.');
  const user = cleanText(m.user, { field: '메일 계정', max: 200, required: false });
  const pass = typeof m.pass === 'string' ? m.pass : '';
  if (pass.length > 200) fail(400, '비밀번호가 너무 깁니다.');
  const fromName = cleanText(m.fromName, { field: '보내는 사람 이름', max: 50, required: false }).replace(/[\r\n"<>]/g, '');
  const fromEmail = cleanText(m.fromEmail, { field: '보내는 사람 이메일', max: 200, required: false }) || (isEmail(user) ? user : '');
  if (!fromEmail || !isEmail(fromEmail)) fail(400, '보내는 사람 이메일을 입력해 주세요. (메일 계정이 이메일 주소면 자동으로 사용)');
  return { preset, host, port, security, user, pass, clearPass: Boolean(m.clearPass), fromName, fromEmail };
}

/** 문서 1건(서명자·서명란 포함) 레코드를 만든다. 저장은 호출하는 쪽에서. */
function newDocRecord({ title, fileName, originalFile, originalHash, pageCount, people, fields, groupId, requireVerification = false, req }) {
  const signers = people.map((p) => ({ id: crypto.randomUUID(), ...p, token: newToken(), status: 'pending' }));
  const docFields = fields.map((f) => ({
    id: crypto.randomUUID(), signerId: signers[f.signerIndex].id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
    ...(INPUT_TYPES.includes(f.type) ? { label: f.label, required: f.required } : {}),
  }));
  const missing = signers.find((s) => !docFields.some((f) => f.signerId === s.id && f.type === 'signature'));
  if (missing) fail(400, people.length === 1 ? '서명란(✍ 서명)을 1개 이상 배치해 주세요.' : `${missing.name} 님의 서명란을 1개 이상 배치해 주세요.`);
  const doc = {
    id: crypto.randomUUID(),
    title,
    fileName,
    pageCount,
    status: 'pending',
    createdAt: now(),
    originalFile,
    originalHash,
    requireVerification,
    signers,
    fields: docFields,
    events: [{ at: now(), type: 'created', ...requestMeta(req) }],
  };
  if (groupId) doc.groupId = groupId;
  return doc;
}

// ───────────── 응답 형태 ─────────────

function ownerView(doc, base) {
  return {
    id: doc.id,
    groupId: doc.groupId || null,
    title: doc.title,
    fileName: doc.fileName,
    pageCount: doc.pageCount,
    status: doc.status,
    requireVerification: Boolean(doc.requireVerification),
    createdAt: doc.createdAt,
    completedAt: doc.completedAt || null,
    originalHash: doc.originalHash,
    completedHash: doc.completedHash || null,
    seal: doc.seal || null,
    signers: doc.signers.map((s) => ({
      id: s.id,
      name: s.name,
      org: s.org || '',
      email: s.email || '',
      status: s.status,
      verifiedAt: s.verifiedAt || null,
      emailSentAt: s.emailSentAt || null,
      completedMailAt: s.completedMailAt || null,
      completedMailError: s.completedMailError || null,
      viewedAt: s.viewedAt || null,
      signedAt: s.signedAt || null,
      signPath: `/sign.html?t=${s.token}`,
      signLink: `${base}/sign.html?t=${s.token}`,
    })),
    fields: doc.fields.map(({ id, signerId, page, x, y, w, h, label, required, value, ...rest }) => ({
      id, signerId, type: typeOf(rest), page, x, y, w, h,
      ...(INPUT_TYPES.includes(typeOf(rest)) ? { label, required: Boolean(required), value: value ?? null } : {}),
    })),
    events: doc.events.map(({ at, type, name, ip, detail }) => ({ at, type, name: name || null, ip: ip || null, detail: detail || null })),
  };
}

function signerView(doc, signer) {
  return {
    documentTitle: doc.title,
    documentStatus: doc.status,
    pageCount: doc.pageCount,
    consentText: CONSENT_TEXT,
    verified: Boolean(signer.verifiedAt),
    signer: { name: signer.name, status: signer.status, signedAt: signer.signedAt || null },
    fields: doc.fields
      .filter((f) => f.signerId === signer.id)
      .map((f) => ({
        id: f.id, type: typeOf(f), page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
        ...(INPUT_TYPES.includes(typeOf(f)) ? { label: f.label, required: Boolean(f.required), value: f.value ?? null } : {}),
      })),
  };
}

function sendPdf(res, filePath, fileName, download) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  });
  if (Buffer.isBuffer(filePath)) res.send(filePath);
  else res.sendFile(filePath);
}

function attachment(res, type, fileName) {
  res.set({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.adminPassword] 지정하면 이 비밀번호로 로그인 (테스트·자동화용)
 * @param {string} [options.publicUrl] 서명 링크에 쓸 주소 (설정 화면 값보다 우선)
 * @param {boolean} [options.lan] 같은 Wi-Fi의 휴대폰에서 접속하는 모드
 * @param {number} [options.port]
 * @param {object} [options.mailTransport] 테스트용 메일 transport ({ sendMail })
 * @param {string} [options.tsaUrl] 타임스탬프 기관(TSA) 주소 고정 (설정 화면 값보다 우선)
 * @param {() => {status: string, url: string|null, error: string|null}} [options.tunnel] 인터넷 공개 터널 상태 (npm run start:public)
 */
function createApp({
  dataDir = path.join(__dirname, 'data'),
  adminPassword = process.env.ADMIN_PASSWORD,
  publicUrl = process.env.PUBLIC_URL,
  lan = false,
  port = 3300,
  mailTransport,
  tsaUrl = process.env.ESIGN_TSA_URL,
  tunnel,
} = {}) {
  const store = createStore(dataDir);
  const seal = loadOrCreateSeal(path.join(dataDir, 'keys'));
  const auth = createAuth({ dataDir, adminPassword });
  const settings = createSettings(dataDir);
  const mailer = createMailer({ getMailSettings: settings.mail, transport: mailTransport });
  const app = express();
  app.disable('x-powered-by');

  /** 봉인에 쓸 타임스탬프 설정 (없으면 undefined → 타임스탬프 없이 B-B) */
  const currentTsaUrl = () => tsaUrl || settings.tsaUrl();
  const tsaOption = (onResult) => (currentTsaUrl() ? { url: currentTsaUrl(), onResult } : undefined);

  /** 서명 링크의 앞부분: 실행 옵션 > 인터넷 공개 터널 > 설정 화면 > LAN 모드 > 지금 접속한 주소 */
  const tunnelState = () => (tunnel ? tunnel() : null);
  const tunnelUrl = () => (!publicUrl && tunnelState()?.status === 'up' ? tunnelState().url : null);
  const baseUrl = (req) => {
    const fixed = publicUrl || tunnelUrl() || settings.publicUrl();
    if (fixed) return fixed.replace(/\/+$/, '');
    const ip = lan && lanAddresses()[0];
    return ip ? `http://${ip}:${port}` : `${req.protocol}://${req.get('host')}`;
  };

  // 터널(cloudflared)은 이 PC 안에서 서버로 접속하므로 원래 접속자 주소는 CF-Connecting-IP 헤더로 온다.
  // 이 헤더는 Cloudflare가 항상 덮어쓰므로 인터넷 쪽에서 위조할 수 없다.
  app.use((req, res, next) => {
    const cf = req.get('cf-connecting-ip');
    req.viaTunnel = isLoopbackAddress(req.socket.remoteAddress) && Boolean(cf);
    req.clientIp = req.viaTunnel ? cf : req.ip;
    next();
  });

  // 인터넷(터널)으로는 서명·문서 검증만 연다. 관리자 화면·API는 서버를 켠 PC(또는 같은 Wi-Fi)에서만.
  const ADMIN_PAGES = new Set(['/', '/index.html', '/new.html', '/group.html', '/doc.html', '/settings.html', '/login.html']);
  const ADMIN_API = ['/api/auth', '/api/documents', '/api/groups', '/api/server-info', '/api/settings'];
  app.use((req, res, next) => {
    if (!req.viaTunnel) return next();
    // Express 경로는 대소문자를 구분하지 않고(/API/documents == /api/documents),
    // Windows 파일 시스템은 끝의 점을 무시한다(settings.html. == settings.html) → 같은 기준으로 맞춰서 비교
    const p = req.path.toLowerCase().replace(/[.\s]+$/, '');
    if (ADMIN_API.some((a) => p === a || p.startsWith(`${a}/`))) {
      return res.status(403).json({ error: '관리자 기능은 서버를 실행한 PC에서만 사용할 수 있습니다.', code: 'admin_local_only' });
    }
    if (ADMIN_PAGES.has(p) || p === '') return res.redirect(302, '/verify.html');
    return next();
  });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', // 서명 링크(토큰)가 외부로 새지 않도록
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    next();
  });
  app.use(express.json({ limit: '25mb' }));

  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  app.use('/vendor/pdfjs', express.static(path.join(pdfjsDir, 'legacy', 'build')));
  app.use('/vendor/pdfjs-cmaps', express.static(path.join(pdfjsDir, 'cmaps')));
  app.use('/vendor/pdfjs-fonts', express.static(path.join(pdfjsDir, 'standard_fonts')));
  app.use('/vendor/pdfjs-wasm', express.static(path.join(pdfjsDir, 'wasm')));
  app.use('/vendor/pdfjs-iccs', express.static(path.join(pdfjsDir, 'iccs')));
  app.use(express.static(path.join(__dirname, 'public')));

  // ───────────── 로그인 ─────────────
  app.use('/api/auth', auth.router);
  // 아래 경로는 관리자만 (서명자 API·검증 API는 제외)
  app.use(['/api/documents', '/api/groups', '/api/server-info', '/api/settings'], auth.requireAdmin);

  app.get('/api/server-info', (req, res) => {
    const base = baseUrl(req);
    res.json({
      publicBaseUrl: base,
      reach: reachability(base),
      lanMode: Boolean(lan),
      publicUrlConfigured: Boolean(publicUrl || settings.publicUrl()),
      lanUrls: lanAddresses().map((ip) => `http://${ip}:${port}`),
      mailConfigured: mailer.configured(),
      tunnel: tunnelState(),
    });
  });

  // ───────────── 설정 (서명 링크 주소 · 메일) ─────────────

  app.get('/api/settings', (req, res) => {
    res.json({
      ...settings.view(),
      fixedByServer: Boolean(publicUrl),
      tsaFixedByServer: tsaUrl || '',
      current: { publicBaseUrl: baseUrl(req), reach: reachability(baseUrl(req)), temporary: Boolean(tunnelUrl()) },
      tunnel: tunnelState(),
      lanUrls: lanAddresses().map((ip) => `http://${ip}:${port}`),
    });
  });

  app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.publicUrl !== undefined) patch.publicUrl = parsePublicUrl(body.publicUrl);
    if (body.mail !== undefined) patch.mail = parseMailSettings(body.mail);
    if (body.tsa !== undefined) patch.tsa = parseTsaSettings(body.tsa);
    if (body.sendCompletedCopy !== undefined) patch.sendCompletedCopy = body.sendCompletedCopy === true;
    settings.update(patch);
    res.json({ ...settings.view(), current: { publicBaseUrl: baseUrl(req), reach: reachability(baseUrl(req)) } });
  });

  app.post('/api/settings/test-tsa', wrap(async (req, res) => {
    const url = parseTsaUrl(req.body?.url);
    if (!url) fail(400, 'TSA 주소를 입력해 주세요.');
    const data = crypto.randomBytes(32);
    try {
      const { token, genTime } = await requestTimestamp(url, data);
      const check = verifyTimestampToken(token, data, seal.trustedCaPems.map((p) => new crypto.X509Certificate(p)));
      res.json({ ok: true, genTime: genTime.toISOString(), tsa: check.tsa, trusted: check.trusted, valid: check.valid });
    } catch (err) {
      fail(502, err.message);
    }
  }));

  app.post('/api/settings/test-mail', wrap(async (req, res) => {
    const to = cleanText(req.body?.to, { field: '받을 이메일', max: 200 });
    if (!isEmail(to)) fail(400, '받을 이메일 형식이 올바르지 않습니다.');
    if (!mailer.configured()) fail(400, '먼저 메일 설정을 저장해 주세요.');
    try {
      await mailer.sendOne({
        to,
        subject: '[e서명] 테스트 메일',
        text: 'e서명 메일 발송 설정이 정상입니다. 이제 교육생에게 서명 요청 메일을 보낼 수 있습니다.',
        html: '<p>e서명 메일 발송 설정이 정상입니다.<br>이제 교육생에게 서명 요청 메일을 보낼 수 있습니다.</p>',
      });
    } catch (err) {
      fail(400, friendlyMailError(err));
    }
    res.json({ ok: true });
  }));

  // ───────────── 개별 문서 (한 문서에 여러 명) ─────────────

  app.get('/api/documents', (req, res) => {
    const list = store.documents()
      .filter((d) => !d.groupId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        createdAt: d.createdAt,
        completedAt: d.completedAt || null,
        signerCount: d.signers.length,
        signedCount: d.signers.filter((s) => s.status === 'signed').length,
      }));
    res.json(list);
  });

  app.post('/api/documents', wrap(async (req, res) => {
    const body = req.body || {};
    const title = cleanText(body.title, { field: '문서 제목', max: 100 });
    const fileName = path.basename(cleanText(body.fileName, { field: '파일명', max: 200, required: false }) || 'document.pdf');
    const { bytes, pageCount } = await parsePdf(body);

    const signersIn = Array.isArray(body.signers) ? body.signers : [];
    if (signersIn.length < 1 || signersIn.length > MAX_SIGNERS) fail(400, `서명자는 1~${MAX_SIGNERS}명이어야 합니다.`);
    const people = signersIn.map((s, i) => parsePerson(s, `${i + 1}번 서명자`));
    const fields = parseFields(body.fields, pageCount, people.length);

    const fileId = crypto.randomUUID();
    const doc = newDocRecord({
      title, fileName, originalFile: `${fileId}.pdf`, originalHash: sha256(bytes), pageCount, people, fields, req,
    });
    fs.writeFileSync(store.filePath(doc.originalFile), bytes);
    store.addDocument(doc);
    res.status(201).json(ownerView(doc, baseUrl(req)));
  }));

  const getOwnedDoc = (req) => store.findDocument(req.params.id) || fail(404, '문서를 찾을 수 없습니다.');
  const completedName = (doc) => (doc.groupId
    ? `${safeFileName(doc.title)}_${safeFileName(doc.signers[0].name)}_서명완료.pdf`
    : `${doc.fileName.replace(/\.pdf$/i, '')}_서명완료.pdf`);

  app.get('/api/documents/:id', (req, res) => res.json(ownerView(getOwnedDoc(req), baseUrl(req))));

  app.get('/api/documents/:id/original.pdf', (req, res) => {
    const doc = getOwnedDoc(req);
    sendPdf(res, store.filePath(doc.originalFile), doc.fileName, 'download' in req.query);
  });

  app.get('/api/documents/:id/completed.pdf', (req, res) => {
    const doc = getOwnedDoc(req);
    if (doc.status !== 'completed') fail(409, '아직 모든 서명이 끝나지 않았습니다.');
    sendPdf(res, store.filePath(doc.completedFile), completedName(doc), 'download' in req.query);
  });

  app.get('/api/documents/:id/signers/:signerId/qr.svg', wrap(async (req, res) => {
    const doc = getOwnedDoc(req);
    const signer = doc.signers.find((s) => s.id === req.params.signerId) || fail(404, '서명자를 찾을 수 없습니다.');
    const svg = await QRCode.toString(`${baseUrl(req)}/sign.html?t=${signer.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).send(svg);
  }));

  // ───────────── 교육생 일괄 서명 (1인 1부) ─────────────

  const sendJobs = new Map(); // groupId → 메일 발송 진행 상황
  const getGroup = (req) => store.findGroup(req.params.id) || fail(404, '일괄 서명 요청을 찾을 수 없습니다.');
  const activeMembers = (group) => group.memberDocIds
    .map((id) => store.findDocument(id))
    .filter((d) => d && d.status !== 'cancelled');

  function memberRows(group, base) {
    return activeMembers(group).map((d, i) => {
      const s = d.signers[0];
      return {
        no: i + 1,
        docId: d.id,
        signerId: s.id,
        name: s.name,
        org: s.org || '',
        phone: s.phone || '',
        email: s.email || '',
        signed: s.status === 'signed',
        status: d.status,
        verifiedAt: s.verifiedAt || null,
        viewedAt: s.viewedAt || null,
        signedAt: s.signedAt || null,
        emailStatus: s.emailStatus || null,
        emailSentAt: s.emailSentAt || null,
        emailError: s.emailError || null,
        ip: s.status === 'signed' ? s.ip || '' : '',
        completedHash: d.completedHash || '',
        answers: d.fields.filter((f) => INPUT_TYPES.includes(typeOf(f))).map((f) => ({ type: f.type, label: f.label, value: f.value ?? null })),
        completedMailAt: s.completedMailAt || null,
        signLink: `${base}/sign.html?t=${s.token}`,
      };
    });
  }

  function groupView(group, base) {
    const members = memberRows(group, base);
    const signed = members.filter((m) => m.signed).length;
    return {
      id: group.id,
      title: group.title,
      info: group.info,
      fileName: group.fileName,
      pageCount: group.pageCount,
      createdAt: group.createdAt,
      requireVerification: group.requireVerification !== false,
      fields: group.fields,
      members,
      counts: { total: members.length, signed },
      mail: {
        configured: mailer.configured(),
        sending: sendJobs.get(group.id) || null,
        sent: members.filter((m) => m.emailStatus === 'sent').length,
        failed: members.filter((m) => m.emailStatus === 'failed').length,
        noEmail: members.filter((m) => !m.email).length,
      },
      link: { base, reach: reachability(base), temporary: Boolean(tunnelUrl()) && base === tunnelUrl(), tunnel: tunnelState() },
    };
  }

  function parseMembers(list, already, requirePhone) {
    if (!Array.isArray(list) || list.length < 1) fail(400, '교육생 명단을 1명 이상 입력해 주세요.');
    if (list.length > MAX_MEMBERS_PER_REQUEST) fail(400, `한 번에 ${MAX_MEMBERS_PER_REQUEST}명까지 등록할 수 있습니다.`);
    if (already + list.length > MAX_MEMBERS_PER_GROUP) fail(400, `한 요청에는 최대 ${MAX_MEMBERS_PER_GROUP}명까지 등록할 수 있습니다.`);
    return list.map((m, i) => parsePerson(m, `${already + i + 1}번 교육생`, { requirePhone }));
  }

  function createMemberDocs(group, people, req) {
    return people.map((person) => newDocRecord({
      title: group.title,
      fileName: group.fileName,
      originalFile: group.templateFile, // 모든 교육생이 같은 원본 PDF를 공유
      originalHash: group.templateHash,
      pageCount: group.pageCount,
      people: [person],
      fields: group.fields.map((f) => ({ ...f, signerIndex: 0 })),
      groupId: group.id,
      requireVerification: group.requireVerification !== false,
      req,
    }));
  }

  app.get('/api/groups', (req, res) => {
    res.json(store.groups()
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => {
        const members = activeMembers(g);
        return {
          id: g.id,
          title: g.title,
          createdAt: g.createdAt,
          total: members.length,
          signed: members.filter((d) => d.signers[0].status === 'signed').length,
        };
      }));
  });

  app.post('/api/groups', wrap(async (req, res) => {
    const body = req.body || {};
    const title = cleanText(body.title, { field: '교육명(문서 제목)', max: 100 }).replace(/[\r\n]+/g, ' ');
    const info = cleanText(body.info, { field: '교육 정보', max: 500, required: false });
    const fileName = path.basename(cleanText(body.fileName, { field: '파일명', max: 200, required: false }) || 'document.pdf');
    const requireVerification = body.requireVerification !== false;
    const { bytes, pageCount } = await parsePdf(body);
    const fields = parseFields(body.fields, pageCount, 1).map(({ signerIndex, ...f }) => f);
    if (!fields.some((f) => f.type === 'signature')) fail(400, '서명란(✍ 서명)을 1개 이상 배치해 주세요.');
    const people = parseMembers(body.members, 0, requireVerification);

    const id = crypto.randomUUID();
    const group = {
      id,
      title,
      info,
      fileName,
      pageCount,
      requireVerification,
      createdAt: now(),
      templateFile: `${id}-template.pdf`,
      templateHash: sha256(bytes),
      fields,
      memberDocIds: [],
    };
    const docs = createMemberDocs(group, people, req);
    fs.writeFileSync(store.filePath(group.templateFile), bytes);
    group.memberDocIds = docs.map((d) => d.id);
    store.documents().push(...docs);
    store.addGroup(group); // 저장 1번
    res.status(201).json(groupView(group, baseUrl(req)));
  }));

  app.get('/api/groups/:id', (req, res) => res.json(groupView(getGroup(req), baseUrl(req))));

  app.get('/api/groups/:id/template.pdf', (req, res) => {
    const group = getGroup(req);
    sendPdf(res, store.filePath(group.templateFile), group.fileName, false);
  });

  app.post('/api/groups/:id/members', (req, res) => {
    const group = getGroup(req);
    const people = parseMembers(req.body?.members, activeMembers(group).length, group.requireVerification !== false);
    const docs = createMemberDocs(group, people, req);
    store.documents().push(...docs);
    group.memberDocIds.push(...docs.map((d) => d.id));
    store.save();
    res.status(201).json(groupView(group, baseUrl(req)));
  });

  const getMemberDoc = (group, docId) => {
    if (!group.memberDocIds.includes(docId)) fail(404, '교육생을 찾을 수 없습니다.');
    const doc = store.findDocument(docId);
    if (doc.status === 'cancelled') fail(409, '취소된 교육생입니다.');
    return doc;
  };

  // 교육생 정보 수정 (서명 전만)
  app.post('/api/groups/:id/members/:docId', (req, res) => {
    const group = getGroup(req);
    const doc = getMemberDoc(group, req.params.docId);
    const signer = doc.signers[0];
    if (signer.status === 'signed') fail(409, '이미 서명한 교육생은 수정할 수 없습니다.');
    const person = parsePerson(req.body, '교육생', { requirePhone: group.requireVerification !== false });
    if (person.email !== signer.email) Object.assign(signer, { emailStatus: null, emailError: null });
    Object.assign(signer, person);
    doc.events.push({ at: now(), type: 'member_updated', ...requestMeta(req) });
    store.save();
    res.json(groupView(group, baseUrl(req)));
  });

  app.post('/api/groups/:id/members/:docId/cancel', (req, res) => {
    const group = getGroup(req);
    const doc = getMemberDoc(group, req.params.docId);
    if (doc.signers[0].status === 'signed') fail(409, '이미 서명한 교육생은 취소할 수 없습니다.');
    doc.status = 'cancelled';
    doc.events.push({ at: now(), type: 'cancelled', ...requestMeta(req) });
    store.save();
    res.json(groupView(group, baseUrl(req)));
  });

  // ── 서명 요청 메일 보내기 (뒤에서 차례로 발송, 화면은 현황을 다시 읽어 진행률 표시) ──
  async function runSendJob(group, docs, base, job) {
    const batch = mailer.batch();
    try {
      for (const doc of docs) {
        const s = doc.signers[0];
        const reminder = s.emailStatus === 'sent';
        const mail = signRequestMail({
          title: group.title,
          info: group.info,
          name: s.name,
          link: `${base}/sign.html?t=${s.token}`,
          reminder,
          verification: doc.requireVerification,
        });
        try {
          await batch.send({ to: { name: s.name, address: s.email }, ...mail });
          Object.assign(s, { emailStatus: 'sent', emailSentAt: now(), emailError: null, emailCount: (s.emailCount || 0) + 1 });
          doc.events.push({ at: s.emailSentAt, type: 'email_sent', name: s.name });
          job.sent += 1;
        } catch (err) {
          Object.assign(s, { emailStatus: 'failed', emailError: friendlyMailError(err) });
          doc.events.push({ at: now(), type: 'email_failed', name: s.name });
          job.failed += 1;
          job.lastError = s.emailError;
        }
        job.done += 1;
        if (job.done % 10 === 0) store.save();
      }
    } finally {
      batch.close();
      job.running = false;
      job.finishedAt = now();
      store.save();
    }
  }

  app.post('/api/groups/:id/send', (req, res) => {
    const group = getGroup(req);
    if (!mailer.configured()) fail(400, '메일 발송 설정이 없습니다. "설정"에서 메일 계정을 먼저 등록해 주세요.', 'mail_not_configured');
    const base = baseUrl(req);
    if (reachability(base) === 'local') {
      fail(400, '서명 링크 주소가 이 PC 전용(localhost)이라 메일을 받은 교육생이 열 수 없습니다. "설정"에서 서명 링크 주소를 지정해 주세요.', 'link_local');
    }
    if (sendJobs.get(group.id)?.running) fail(409, '이미 메일을 보내는 중입니다.');

    const scope = req.body?.scope;
    let docs = activeMembers(group).filter((d) => d.signers[0].status !== 'signed' && d.signers[0].email);
    if (scope === 'unsent') docs = docs.filter((d) => d.signers[0].emailStatus !== 'sent');
    else if (scope === 'one') docs = docs.filter((d) => d.id === req.body?.docId);
    else if (scope !== 'unsigned') fail(400, '보낼 대상을 골라 주세요.');
    if (docs.length === 0) fail(400, '보낼 대상이 없습니다. (이메일 주소가 있고 아직 서명하지 않은 교육생)');

    const job = { running: true, total: docs.length, done: 0, sent: 0, failed: 0, startedAt: now() };
    sendJobs.set(group.id, job);
    runSendJob(group, docs, base, job).catch((err) => console.error('[mail] 발송 작업 오류', err));
    res.status(202).json({ queued: docs.length });
  });

  // ── 서명자 명단 / 현황 내보내기 ──

  const signatureImageOf = (doc) => {
    const field = doc.fields.find((f) => typeOf(f) === 'signature' && f.signatureFile);
    return field ? fs.readFileSync(store.filePath(field.signatureFile)) : null;
  };

  /** ?all 이면 미서명자 포함 "서명 현황", 아니면 "서명자 명단" */
  function rosterRows(group, req) {
    const signedOnly = !('all' in req.query);
    const docs = activeMembers(group);
    let rows = memberRows(group, baseUrl(req)).map((m, i) => ({ ...m, doc: docs[i] }));
    if (signedOnly) rows = rows.filter((r) => r.signed).map((r, i) => ({ ...r, no: i + 1 }));
    return { rows, signedOnly, total: docs.length };
  }

  app.get('/api/groups/:id/roster.pdf', wrap(async (req, res) => {
    const group = getGroup(req);
    const { rows, signedOnly, total } = rosterRows(group, req);
    const signed = rows.filter((r) => r.signed).length;
    const pdf = await buildRosterPdf({
      group: {
        title: group.title,
        info: group.info,
        summary: signedOnly ? `서명 ${signed}명 (전체 ${total}명 중)` : `총 ${total}명 · 서명 ${signed}명 · 미서명 ${total - signed}명`,
      },
      rows: rows.map((r) => ({ ...r, signaturePng: r.signed ? signatureImageOf(r.doc) : null })),
      seal,
      signedOnly,
      tsa: tsaOption(),
    });
    sendPdf(res, Buffer.from(pdf), `${signedOnly ? '서명자명단' : '서명현황'}_${safeFileName(group.title)}.pdf`, 'download' in req.query);
  }));

  app.get('/api/groups/:id/roster.xlsx', (req, res) => {
    const group = getGroup(req);
    const { rows, signedOnly } = rosterRows(group, req);
    attachment(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${signedOnly ? '서명자명단' : '서명현황'}_${safeFileName(group.title)}.xlsx`);
    const inputLabels = group.fields.filter((f) => INPUT_TYPES.includes(typeOf(f))).map((f) => f.label);
    res.send(buildRosterXlsx(rows, { signedOnly, inputLabels }));
  });

  app.get('/api/groups/:id/signed.zip', (req, res) => {
    const group = getGroup(req);
    const entries = activeMembers(group)
      .map((d, i) => ({ d, no: i + 1 }))
      .filter(({ d }) => d.status === 'completed')
      .map(({ d, no }) => ({
        name: `${String(no).padStart(3, '0')}_${safeFileName(d.signers[0].name)}_서명완료.pdf`,
        data: fs.readFileSync(store.filePath(d.completedFile)),
        date: new Date(d.completedAt),
      }));
    if (entries.length === 0) fail(409, '아직 서명을 마친 교육생이 없습니다.');
    attachment(res, 'application/zip', `서명완료_${safeFileName(group.title)}.zip`);
    res.send(createZip(entries));
  });

  // ───────────── 서명자 API (링크의 토큰으로만 접근, 로그인 불필요) ─────────────

  const signerSessions = new Map(); // 세션 토큰 → { signerId, expires }

  function isVerified(req, signer) {
    const token = readCookie(req, SIGNER_COOKIE);
    const session = token && signerSessions.get(token);
    if (!session || session.expires < Date.now()) return false;
    return session.signerId === signer.id;
  }

  function startSignerSession(req, res, signer) {
    for (const [k, v] of signerSessions) if (v.expires < Date.now()) signerSessions.delete(k);
    const token = crypto.randomBytes(32).toString('base64url');
    signerSessions.set(token, { signerId: signer.id, expires: Date.now() + SIGNER_SESSION_MS });
    res.setHeader('Set-Cookie', `${SIGNER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/api/sign; Max-Age=${SIGNER_SESSION_MS / 1000}${req.secure || req.viaTunnel ? '; Secure' : ''}`);
  }

  const findSigner = (req) => {
    const found = store.findBySignerToken(req.params.token) || fail(404, '유효하지 않은 서명 링크입니다.');
    if (found.doc.status === 'cancelled') fail(410, '취소된 서명 요청입니다. 담당자에게 문의해 주세요.');
    return found;
  };
  /** 본인 확인이 필요한 문서면 확인을 마친 경우에만 통과 */
  const getSigner = (req) => {
    const found = findSigner(req);
    if (found.doc.requireVerification && !isVerified(req, found.signer)) fail(403, '본인 확인이 필요합니다.', 'verify');
    return found;
  };

  function markViewed(req, doc, signer) {
    if (signer.viewedAt) return;
    signer.viewedAt = now();
    doc.events.push({ at: signer.viewedAt, type: 'viewed', name: signer.name, ...requestMeta(req) });
    store.save();
  }

  app.get('/api/sign/:token', (req, res) => {
    const { doc, signer } = findSigner(req);
    if (doc.requireVerification && !isVerified(req, signer)) {
      // 본인 확인 전에는 누구의 링크인지·문서 내용을 알려주지 않는다
      return res.json({ verificationRequired: true, documentTitle: doc.title });
    }
    markViewed(req, doc, signer);
    return res.json(signerView(doc, signer));
  });

  app.post('/api/sign/:token/verify', (req, res) => {
    const { doc, signer } = findSigner(req);
    if (!doc.requireVerification) return res.json(signerView(doc, signer));
    const lockedUntil = signer.verifyLockedUntil ? Date.parse(signer.verifyLockedUntil) : 0;
    if (lockedUntil > Date.now()) {
      fail(429, `본인 확인을 여러 번 틀려 잠시 잠겼습니다. ${Math.ceil((lockedUntil - Date.now()) / 60000)}분 뒤에 다시 시도하거나 담당자에게 문의해 주세요.`);
    }
    const expectedPhone = normalizePhone(signer.phone);
    const ok = expectedPhone.length >= 9
      && normalizeName(req.body?.name) === normalizeName(signer.name)
      && normalizePhone(req.body?.phone) === expectedPhone;
    if (!ok) {
      signer.verifyFailures = (signer.verifyFailures || 0) + 1;
      doc.events.push({ at: now(), type: 'verify_failed', ...requestMeta(req) });
      const left = VERIFY_MAX_FAILURES - signer.verifyFailures;
      if (left <= 0) {
        signer.verifyFailures = 0;
        signer.verifyLockedUntil = new Date(Date.now() + VERIFY_LOCK_MS).toISOString();
      }
      store.save();
      fail(401, left > 0
        ? `이름 또는 전화번호가 등록된 정보와 다릅니다. (남은 시도 ${left}회)`
        : '여러 번 틀려 15분 동안 잠겼습니다. 담당자에게 등록된 정보를 확인해 주세요.');
    }
    signer.verifyFailures = 0;
    signer.verifyLockedUntil = null;
    signer.verifiedAt = now();
    doc.events.push({ at: signer.verifiedAt, type: 'verified', name: signer.name, ...requestMeta(req) });
    store.save();
    startSignerSession(req, res, signer);
    markViewed(req, doc, signer);
    return res.json(signerView(doc, signer));
  });

  app.get('/api/sign/:token/document.pdf', (req, res) => {
    const { doc } = getSigner(req);
    sendPdf(res, store.filePath(doc.originalFile), doc.fileName, false);
  });

  app.get('/api/sign/:token/completed.pdf', (req, res) => {
    const { doc } = getSigner(req);
    if (doc.status !== 'completed') fail(409, '아직 모든 서명이 끝나지 않았습니다.');
    sendPdf(res, store.filePath(doc.completedFile), completedName(doc), true);
  });

  app.post('/api/sign/:token', wrap(async (req, res) => {
    const { doc, signer } = getSigner(req);
    if (doc.status !== 'pending') fail(409, '이미 완료되었거나 처리 중인 문서입니다.');
    if (signer.status === 'signed') fail(409, '이미 서명하셨습니다.');

    const { consent, signatures, values = {} } = req.body || {};
    if (consent !== true) fail(400, '전자서명 동의에 체크해 주세요.');
    if (!signatures || typeof signatures !== 'object') fail(400, '서명이 없습니다.');
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, '입력값 형식이 올바르지 않습니다.');
    const answers = parseAnswers(doc.fields.filter((f) => f.signerId === signer.id && INPUT_TYPES.includes(typeOf(f))), values);

    // 이름·날짜 칸은 자동 입력이므로 서명 이미지는 "서명" 칸에만 받는다
    const myFields = doc.fields.filter((f) => f.signerId === signer.id && typeOf(f) === 'signature');
    const keys = Object.keys(signatures);
    if (keys.length !== myFields.length || !myFields.every((f) => keys.includes(f.id))) {
      fail(400, '모든 서명란에 서명해 주세요.');
    }

    const images = myFields.map((f) => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signatures[f.id]));
      const png = m && Buffer.from(m[1], 'base64');
      if (!png || png.length < 8 || png.readBigUInt64BE(0) !== 0x89504e470d0a1a0an) fail(400, '서명 이미지 형식이 올바르지 않습니다.');
      if (png.length > MAX_SIGNATURE_BYTES) fail(413, '서명 이미지가 너무 큽니다.');
      return { field: f, png };
    });

    // 여기까지는 await 없이 동기로 진행 → 같은 서명자의 중복 제출이 끼어들 수 없음
    for (const { field, png } of images) {
      field.signatureFile = `${doc.id}-${field.id}.png`;
      fs.writeFileSync(store.filePath(field.signatureFile), png);
    }
    for (const { field, value } of answers) field.value = value;
    const meta = requestMeta(req);
    Object.assign(signer, { status: 'signed', signedAt: now(), ...meta });
    doc.events.push({ at: signer.signedAt, type: 'signed', name: signer.name, ...meta });

    if (doc.signers.every((s) => s.status === 'signed')) {
      doc.status = 'finalizing';
      store.save();
      try {
        await finalize(doc);
      } catch (err) {
        console.error('[finalize] 실패', doc.id, err);
        doc.status = 'failed';
        doc.events.push({ at: now(), type: 'failed' });
      }
    }
    store.save();
    res.json(signerView(doc, signer));
    if (doc.status === 'completed') sendCompletedCopies(doc);
  }));

  /** 서명 완료본 PDF를 이메일이 있는 서명자에게 보낸다 (응답을 기다리게 하지 않음) */
  const pendingMails = new Set();
  function sendCompletedCopies(doc) {
    if (!settings.sendCompletedCopy() || !mailer.configured()) return;
    const targets = doc.signers.filter((s) => s.email && !s.completedMailAt);
    if (targets.length === 0) return;
    const pdf = fs.readFileSync(store.filePath(doc.completedFile));
    for (const s of targets) {
      const mail = completedCopyMail({ title: doc.title, name: s.name, signedAt: s.signedAt });
      const job = mailer.sendOne({
        to: { name: s.name, address: s.email },
        ...mail,
        attachments: [{ filename: completedName(doc), content: pdf, contentType: 'application/pdf' }],
      }).then(() => {
        s.completedMailAt = now();
        s.completedMailError = null;
        doc.events.push({ at: s.completedMailAt, type: 'completed_mail_sent', name: s.name });
      }, (err) => {
        s.completedMailError = friendlyMailError(err);
        doc.events.push({ at: now(), type: 'completed_mail_failed', name: s.name, detail: s.completedMailError });
      }).finally(() => {
        store.save();
        pendingMails.delete(job);
      });
      pendingMails.add(job);
    }
  }
  /** 테스트용: 보내는 중인 완료본 메일이 모두 끝날 때까지 기다린다 */
  app.flushMails = () => Promise.all([...pendingMails]);

  async function finalize(doc) {
    const originalBytes = fs.readFileSync(store.filePath(doc.originalFile));
    if (sha256(originalBytes) !== doc.originalHash) throw new Error('원본 PDF가 변경되었습니다.');
    doc.completedAt = now();
    let stamp = null;
    const out = await buildCompletedPdf({
      originalBytes,
      doc,
      consentText: CONSENT_TEXT,
      seal,
      tsa: tsaOption((r) => { stamp = r; }),
      readSignature: (field) => fs.readFileSync(store.filePath(field.signatureFile)),
    });
    doc.seal = {
      format: stamp?.ok ? 'PAdES-B-T' : 'PAdES-B-B',
      subject: seal.info.subject,
      fingerprint256: seal.info.fingerprint256,
      ...(stamp?.ok ? { timestamp: { genTime: stamp.genTime, url: stamp.url } } : {}),
    };
    doc.completedFile = `${doc.id}-completed.pdf`;
    fs.writeFileSync(store.filePath(doc.completedFile), out);
    doc.completedHash = sha256(out);
    doc.status = 'completed';
    doc.events.push({ at: doc.completedAt, type: 'completed' });
    if (stamp?.ok) doc.events.push({ at: stamp.genTime, type: 'timestamped', detail: stamp.url });
    else if (stamp) doc.events.push({ at: now(), type: 'timestamp_failed', detail: stamp.error });
  }

  // ───────────── 문서 검증 (누구나) ─────────────

  app.post('/api/verify', (req, res) => {
    const hash = String(req.body?.hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) fail(400, '올바른 SHA-256 해시가 아닙니다.');
    const completed = store.documents().find((d) => d.completedHash === hash);
    if (completed) {
      return res.json({
        match: 'completed',
        title: completed.title,
        completedAt: completed.completedAt,
        signers: completed.signers.map((s) => ({ name: s.name, signedAt: s.signedAt })),
      });
    }
    const original = store.documents().find((d) => d.originalHash === hash);
    if (original) return res.json({ match: 'original', title: original.title, status: original.status });
    return res.json({ match: null });
  });

  app.get('/api/seal', (req, res) => res.json({ ...seal.info, selfIssued: seal.selfIssued }));

  // 루트 인증서(공개 정보) — Adobe 등에 "신뢰하는 인증서"로 추가할 때 사용
  app.get('/api/seal/ca.crt', (req, res) => {
    const pem = seal.trustedCaPems[0];
    if (!pem) fail(404, '내려받을 루트 인증서가 없습니다.');
    res.set({
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="esign-root-ca.crt"',
    });
    res.send(pem);
  });

  // 업로드한 PDF는 저장하지 않고 검사만 한다
  app.post('/api/verify-signature', (req, res) => {
    if (typeof req.body?.pdfBase64 !== 'string') fail(400, 'PDF 파일을 올려 주세요.');
    const pdf = Buffer.from(req.body.pdfBase64, 'base64');
    if (pdf.length === 0 || !pdf.subarray(0, 1024).includes('%PDF-')) fail(400, 'PDF 파일이 아닙니다.');
    if (pdf.length > MAX_PDF_BYTES + 1024 * 1024) fail(413, '파일이 너무 큽니다.');
    res.json(verifyPdfSignatures(pdf, seal.trustedCaPems));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: '없는 API입니다.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: '파일이 너무 큽니다.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });
    console.error(err);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return app;
}

if (require.main === module) {
  const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
  const lan = process.argv.includes('--lan') || process.env.HOST === '0.0.0.0';
  const port = Number(arg('port') || process.env.PORT) || 3300;
  const host = lan ? '0.0.0.0' : process.env.HOST || '127.0.0.1';
  const dataDir = path.resolve(arg('data') || process.env.ESIGN_DATA_DIR || path.join(__dirname, 'data'));
  const isPublic = process.argv.includes('--public');
  let tunnel;
  if (isPublic) {
    const { startTunnel } = require('./lib/tunnel');
    tunnel = startTunnel({
      port,
      onUrl: (url) => {
        console.log(`🌐 인터넷 공개 주소: ${url}`);
        console.log('   교육생 메일 속 서명 링크가 이 주소로 나갑니다. 서명이 끝날 때까지 이 창과 PC를 켜 두세요.');
        console.log('   (서버를 다시 켜면 주소가 바뀝니다 → 교육생 현황에서 "미서명자에게 다시 알림")');
      },
    });
    if (tunnel.state().status === 'missing') {
      console.log('⚠ 인터넷 공개에 필요한 cloudflared 프로그램이 없습니다. 설치 후 다시 실행하세요:');
      console.log('    winget install --id Cloudflare.cloudflared');
    }
  }
  createApp({ lan, port, dataDir, tunnel: tunnel && tunnel.state }).listen(port, host, () => {
    console.log(`전자서명 서비스 실행 중 → http://localhost:${port}`);
    if (isPublic) {
      console.log('  관리자 화면은 이 PC의 위 주소에서만 열립니다. 인터넷 주소로는 서명·문서 검증만 됩니다.');
      if (tunnel.state().status !== 'missing') console.log('  인터넷 공개 주소를 만드는 중…');
    } else if (lan) {
      for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi의 휴대폰에서: http://${ip}:${port}`);
    } else {
      console.log('  (이 PC에서만 접속 가능 — 휴대폰으로 서명받으려면 npm run start:lan)');
    }
  });
}

module.exports = { createApp, lanAddresses, normalizePhone, normalizeName, reachability };
