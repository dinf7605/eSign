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
  completed_mail_sent: '서명 완료본 메일 발송',
  completed_mail_failed: '서명 완료본 메일 발송 실패',
  failed: '최종 PDF 생성 실패',
  cancelled: '서명 요청 취소',
  member_updated: '교육생 정보 수정',
};

// 서명란 종류: 서명은 직접 그리고, 이름·날짜는 서명 완료 시 자동으로 채워짐
export const FIELD_TYPES = {
  signature: { label: '✍ 서명', short: '서명', color: '#2f5bea', w: 0.24, ratio: 3 },
  name: { label: '이름 (자동)', short: '이름', color: '#0c8a5a', w: 0.18, ratio: 4.5 },
  date: { label: '날짜 (자동)', short: '날짜', color: '#d97706', w: 0.18, ratio: 4.5 },
  checkbox: { label: '☑ 체크', short: '체크', color: '#7c3aed', w: 0.035, ratio: 1, input: true },
  text: { label: '✎ 입력란', short: '입력', color: '#0891b2', w: 0.28, ratio: 7, input: true },
};
/** 서명자가 직접 체크·입력하는 칸 */
export const isInputType = (type) => Boolean(FIELD_TYPES[type]?.input);

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

// ───── 서명 기한 · 자동 다시 알림 ─────
export const REMIND_CHOICES = [7, 5, 3, 2, 1];
const pad2 = (n) => String(n).padStart(2, '0');
/** ISO → <input type="datetime-local"> 값 (이 PC 시간대) */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** <input type="datetime-local"> 값 → ISO (비었으면 null) */
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
/** 기한 표시: 11월 15일 (일) 오후 6:00 */
export function fmtDeadline(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ${d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`;
}
/** D-3 (달력 날짜 기준) / 오늘 마감 · 5시간 남음 / 마감 */
export function dDay(iso) {
  const end = new Date(iso);
  const ms = end.getTime() - Date.now();
  if (ms <= 0) return '마감';
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(end) - startOf(new Date())) / 86400000);
  if (days === 0) return ms < 3600000 ? `오늘 마감 · ${Math.max(1, Math.round(ms / 60000))}분 남음` : `오늘 마감 · ${Math.round(ms / 3600000)}시간 남음`;
  return `D-${days}`;
}
/**
 * 기한 입력 묶음: 날짜·시각 + 빠른 선택(3일 뒤·1주 뒤 오후 6시) + 자동 다시 알림(기한 N일 전)
 * @returns {{ el: HTMLElement, value: () => {deadline: string|null, autoRemind: number[]} }}
 */
export function deadlineInput({ deadline = null, autoRemind = [3, 1] } = {}) {
  const input = h('input', { type: 'datetime-local', value: toLocalInput(deadline), min: toLocalInput(new Date().toISOString()) });
  const boxes = REMIND_CHOICES.map((d) => h('input', { type: 'checkbox', value: String(d), checked: autoRemind.includes(d) }));
  const remind = h('div', { class: 'remind-choices small' },
    h('span', { class: 'muted' }, '자동 다시 알림: 기한'),
    ...boxes.map((b) => h('label', {}, b, ` ${b.value}일 전`)));
  const sync = () => {
    const off = !input.value;
    remind.classList.toggle('disabled', off);
    for (const b of boxes) b.disabled = off;
  };
  const quick = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(18, 0, 0, 0);
    input.value = toLocalInput(d.toISOString());
    sync();
  };
  input.addEventListener('input', sync);
  sync();
  const el = h('div', { class: 'deadline-input' },
    h('div', { class: 'row', style: { gap: '6px' } },
      input,
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => quick(3) }, '3일 뒤'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => quick(7) }, '1주 뒤'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { input.value = ''; sync(); } }, '없음')),
    remind);
  return {
    el,
    value: () => ({
      deadline: fromLocalInput(input.value),
      autoRemind: input.value ? boxes.filter((b) => b.checked).map((b) => Number(b.value)) : [],
    }),
  };
}
