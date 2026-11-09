// 여러 페이지에서 같이 쓰는 도우미
export const COLORS = ['#2f5bea', '#d6336c', '#0c8a5a', '#d97706', '#7c3aed', '#0891b2', '#c2410c', '#4d7c0f', '#9333ea', '#475569'];

export const STATUS_LABEL = { pending: '서명 대기', finalizing: '처리 중', completed: '완료', failed: '오류', signed: '서명 완료', cancelled: '취소됨' };
export const EVENT_LABEL = {
  created: '문서 생성',
  email_sent: '서명 요청 메일 발송',
  email_failed: '메일 발송 실패',
  verify_failed: '본인 확인 실패',
  verified: '본인 확인 (이름·전화번호 일치)',
  viewed: '문서 열람',
  signed: '서명 완료',
  completed: '모든 서명 완료 · 최종 PDF 생성',
  timestamped: '타임스탬프 발급 (서명 시각 증명)',
  timestamp_failed: '타임스탬프 실패 — 타임스탬프 없이 봉인',
  failed: '최종 PDF 생성 실패',
  cancelled: '서명 요청 취소',
  member_updated: '교육생 정보 수정',
};

// 서명란 종류: 서명은 직접 그리고, 이름·날짜는 서명 완료 시 자동으로 채워짐
export const FIELD_TYPES = {
  signature: { label: '✍ 서명', short: '서명', color: '#2f5bea', w: 0.24, ratio: 3 },
  name: { label: '이름 (자동)', short: '이름', color: '#0c8a5a', w: 0.18, ratio: 4.5 },
  date: { label: '날짜 (자동)', short: '날짜', color: '#d97706', w: 0.18, ratio: 4.5 },
};

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Requested-With': 'esign', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (res.status === 401 && data?.code === 'auth' && !location.pathname.startsWith('/login')) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    await new Promise(() => {}); // 이동하는 동안 이후 코드 멈춤
  }
  if (!res.ok) throw new Error(data?.error || `요청에 실패했습니다. (${res.status})`);
  return data;
}

/** 엑셀에서 복사한 명단(탭/쉼표 구분)을 교육생 목록으로 바꾼다. 열: 이름, 소속, 연락처/이메일 (순서 자유) */
export function parseMemberList(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.includes('\t') ? line.split('\t') : line.split(/\s*,\s*/)).map((c) => c.trim().replace(/^"|"$/g, '')));
  if (rows[0] && /^(이름|성명|name)$/i.test(rows[0][0])) rows.shift(); // 머리글 줄
  return rows
    .filter((cols) => cols[0])
    .map(([name, ...rest]) => {
      const m = { name };
      for (const c of rest) {
        if (!c) continue;
        if (c.includes('@')) m.email ||= c;
        else if (/^[0-9+\-()\s]{7,}$/.test(c)) m.phone ||= c;
        else m.org ||= c;
      }
      return m;
    });
}

// 상단 메뉴의 로그아웃 버튼
document.getElementById('logout')?.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = '/login.html';
});

/** 간단한 DOM 생성기. 사용자 입력은 항상 텍스트 노드로 넣어 XSS를 막는다. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR') : '-');

export function badge(status) {
  return h('span', { class: `badge badge-${status}` }, STATUS_LABEL[status] || status);
}

let toastTimer;
export function toast(message, type = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = type; }, 2800);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('링크를 복사했습니다.');
  } catch {
    toast('복사하지 못했습니다. 직접 선택해서 복사해 주세요.', 'error');
  }
}

/** 페이지 위에 서명란 상자를 그린다 (좌표는 페이지 크기 대비 비율) */
export function placeBox(el, f) {
  Object.assign(el.style, {
    left: `${f.x * 100}%`,
    top: `${f.y * 100}%`,
    width: `${f.w * 100}%`,
    height: `${f.h * 100}%`,
  });
}

export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
