'use strict';
// 메일 발송 (nodemailer / SMTP) + 서명 요청 메일 내용
const nodemailer = require('nodemailer');

function transportOptions(m) {
  return {
    host: m.host,
    port: Number(m.port),
    secure: m.security === 'ssl', // 465
    requireTLS: m.security === 'starttls', // 587
    ignoreTLS: m.security === 'none', // 사내 테스트 서버 등
    auth: m.user ? { user: m.user, pass: m.pass || '' } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
}

/**
 * @param {object} p
 * @param {() => object} p.getMailSettings
 * @param {object} [p.transport] 테스트용으로 주입하는 nodemailer 호환 transport ({ sendMail })
 */
function createMailer({ getMailSettings, transport: injected }) {
  const from = () => {
    const m = getMailSettings();
    return { name: m.fromName || 'e서명', address: m.fromEmail || m.user };
  };
  const build = (pool) => injected || nodemailer.createTransport({
    ...transportOptions(getMailSettings()),
    ...(pool ? { pool: true, maxConnections: 2, maxMessages: 100 } : {}),
  });

  return {
    configured() {
      if (injected) return true;
      const m = getMailSettings();
      return Boolean(m.host && (m.fromEmail || m.user));
    },
    async sendOne(message) {
      const t = build(false);
      try {
        return await t.sendMail({ from: from(), ...message });
      } finally {
        if (!injected) t.close();
      }
    },
    /** 여러 통을 보낼 때 연결을 재사용 */
    batch() {
      const t = build(true);
      return {
        send: (message) => t.sendMail({ from: from(), ...message }),
        close: () => { if (!injected) t.close(); },
      };
    },
  };
}

/** SMTP 오류를 담당자가 이해할 수 있는 말로 */
function friendlyMailError(err) {
  const code = err?.code || '';
  if (code === 'EAUTH') return '메일 계정 로그인 실패 — 아이디·비밀번호(앱 비밀번호)를 확인해 주세요.';
  if (['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ECONNREFUSED'].includes(code) || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(err?.message || '')) {
    return '메일 서버에 연결할 수 없음 — 서버 주소·포트·보안 방식을 확인해 주세요.';
  }
  if (code === 'EENVELOPE') return '받는 사람 이메일 주소가 올바르지 않거나 거부되었습니다.';
  if (code === 'EMESSAGE') return '메일 내용 오류로 보내지 못했습니다.';
  return `메일 발송 실패: ${String(err?.message || err).slice(0, 200)}`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/** 교육생에게 보내는 서명 요청 메일 */
/** 기한 표시: 2026년 11월 15일 (일) 오후 6:00 */
function formatDeadline(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const time = d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' });
  return `${date} ${time}`;
}

function signRequestMail({ title, info, name, link, reminder = false, verification = true, deadline = null }) {
  const t = oneLine(title);
  const due = deadline ? formatDeadline(deadline) : '';
  const subject = reminder ? `[다시 알림] ${t} 서명 요청` : `[서명 요청] ${t}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa">
<div style="background:#f4f6fa;padding:24px 12px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#1b2333">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e3e7ef">
    <div style="font-weight:800;font-size:18px;margin-bottom:18px">e<span style="color:#2f5bea">서명</span></div>
    <p style="font-size:16px;margin:0 0 6px"><b>${escapeHtml(name)}</b> 님, 안녕하세요.</p>
    <p style="margin:0 0 4px">${reminder ? '아직 서명하지 않은 문서가 있어 다시 안내드립니다.' : '아래 문서에 서명을 부탁드립니다.'}</p>
    <div style="background:#f7f9fd;border:1px solid #e3e7ef;border-radius:8px;padding:14px 16px;margin:16px 0">
      <div style="font-weight:700">${escapeHtml(t)}</div>
      ${info ? `<div style="white-space:pre-line;color:#6b7486;font-size:13px;margin-top:6px">${escapeHtml(info)}</div>` : ''}
      ${due ? `<div style="color:#b35c00;font-size:13px;font-weight:700;margin-top:8px">서명 기한: ${escapeHtml(due)}까지</div>` : ''}
    </div>
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700">문서 확인하고 서명하기</a>
    ${verification ? '<p style="font-size:13px;color:#6b7486;margin:16px 0 0">서명 전에 <b>이름과 전화번호</b>로 본인 확인을 합니다.</p>' : ''}
    <p style="font-size:12px;color:#9aa1b0;margin:18px 0 0">버튼이 열리지 않으면 아래 주소를 복사해 브라우저에 붙여넣으세요.<br>
      <a href="${escapeHtml(link)}" style="color:#2f5bea;word-break:break-all">${escapeHtml(link)}</a></p>
    <p style="font-size:12px;color:#9aa1b0;margin:10px 0 0">이 링크는 ${escapeHtml(name)} 님 전용입니다. 다른 사람에게 전달하지 마세요.</p>
  </div>
</div></body></html>`;
  const text = [
    `${name} 님, 안녕하세요.`,
    reminder ? '아직 서명하지 않은 문서가 있어 다시 안내드립니다.' : '아래 문서에 서명을 부탁드립니다.',
    '',
    `■ ${t}`,
    info || '',
    due ? `서명 기한: ${due}까지` : '',
    '',
    `서명하기: ${link}`,
    verification ? '(서명 전에 이름과 전화번호로 본인 확인을 합니다.)' : '',
    `이 링크는 ${name} 님 전용입니다. 다른 사람에게 전달하지 마세요.`,
  ].filter((l) => l !== null).join('\n');
  return { subject, html, text };
}

/** 서명 완료본 안내 메일 (PDF는 첨부로 함께 보낸다) */
function completedCopyMail({ title, name, signedAt }) {
  const t = oneLine(title);
  const when = signedAt
    ? new Date(signedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' })
    : '';
  const subject = `[서명 완료] ${t}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa">
<div style="background:#f4f6fa;padding:24px 12px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#1b2333">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e3e7ef">
    <div style="font-weight:800;font-size:18px;margin-bottom:18px">e<span style="color:#2f5bea">서명</span></div>
    <p style="font-size:16px;margin:0 0 6px"><b>${escapeHtml(name)}</b> 님, 서명이 완료되었습니다.</p>
    <div style="background:#f7f9fd;border:1px solid #e3e7ef;border-radius:8px;padding:14px 16px;margin:16px 0">
      <div style="font-weight:700">${escapeHtml(t)}</div>
      ${when ? `<div style="color:#6b7486;font-size:13px;margin-top:6px">서명 일시: ${escapeHtml(when)}</div>` : ''}
    </div>
    <p style="margin:0">서명이 들어간 최종 문서(PDF)를 <b>첨부파일</b>로 보내드립니다. 보관해 두세요.</p>
    <p style="font-size:13px;color:#6b7486;margin:14px 0 0">이 PDF에는 위변조를 막는 전자서명과 서명 기록(감사 추적 인증서)이 들어 있습니다.</p>
  </div>
</div></body></html>`;
  const text = [
    `${name} 님, 서명이 완료되었습니다.`,
    '',
    `■ ${t}`,
    when ? `서명 일시: ${when}` : '',
    '',
    '서명이 들어간 최종 문서(PDF)를 첨부파일로 보내드립니다. 보관해 두세요.',
  ].join('\n');
  return { subject, html, text };
}

module.exports = { createMailer, friendlyMailError, signRequestMail, completedCopyMail, formatDeadline, transportOptions };
