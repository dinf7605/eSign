// 교육생 명단 해석 (CSV 파일·엑셀 붙여넣기 공통). 다른 모듈을 가져오지 않는 순수 함수만 둔다(자동 테스트에서 바로 불러 씀).

export const ROSTER_COLUMNS = ['name', 'org', 'phone', 'email'];

const HEADER_KEYS = {
  name: ['이름', '성명', '성함', '교육생', '교육생명', '교육생이름', '수강생', '수강생명', 'name', 'fullname'],
  org: ['소속', '반', '부서', '기관', '소속기관', '회사', '회사명', '팀', '학교', 'org', 'organization', 'company', 'group', 'class'],
  phone: ['전화번호', '전화', '휴대폰', '휴대폰번호', '핸드폰', '핸드폰번호', '휴대전화', '휴대전화번호', '연락처', 'phone', 'mobile', 'tel', 'phonenumber', 'cellphone'],
  email: ['이메일', '이메일주소', '메일', '메일주소', '전자우편', 'email', 'e-mail', 'mail', 'emailaddress'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksEmail = (s) => s.includes('@');
const looksPhone = (s) => /^[0-9+\-()\s]{7,}$/.test(s);
const looksRowNumber = (s) => /^\d{1,4}\.?$/.test(s); // 엑셀의 "번호" 열

/** 파일 바이트 → 글자. UTF-8이 아니면 한국어 엑셀 기본 CSV 인코딩(CP949/EUC-KR)으로 읽는다. */
export function decodeCsvBytes(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('euc-kr').decode(bytes);
  }
  return text.replace(/^﻿/, '');
}

/** 첫 줄(따옴표 밖)에서 가장 많이 나온 구분자: 쉼표·탭·세미콜론 */
function detectDelimiter(text) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

/** CSV/TSV 글자 → 2차원 배열 (RFC 4180: 따옴표, "" 이스케이프, 칸 안 줄바꿈) */
export function parseCsv(text, delimiter) {
  const src = String(text || '').replace(/^﻿/, '');
  const delim = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; } // 구분자 뒤 공백 + 따옴표도 허용
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows
    .map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((r) => r.some(Boolean));
}

/** 엑셀이 지운 휴대폰 앞자리 0 복구: 1012345678 → 01012345678 */
export function fixPhone(phone) {
  const p = String(phone || '').trim();
  if (/^1[0-9]{9}$/.test(p)) return `0${p}`;
  return p;
}

const normHeader = (s) => s.toLowerCase().replace(/[\s*()[\]_]/g, '').replace(/^﻿/, '');

/** 머리글 줄이면 { name: 열번호, … }, 아니면 null */
export function headerMap(row) {
  const map = {};
  row.forEach((cell, i) => {
    const key = normHeader(cell);
    if (!key) return;
    for (const [col, words] of Object.entries(HEADER_KEYS)) {
      if (map[col] === undefined && words.includes(key)) { map[col] = i; return; }
    }
  });
  return map.name !== undefined ? map : null;
}

/** 머리글 없는 한 줄: 이메일(@)·전화번호(숫자)는 내용으로 알아보고, 첫 글자 칸은 이름, 다음 글자 칸은 소속 */
function guessRow(cells) {
  const m = { name: '', org: '', phone: '', email: '' };
  for (const c of cells) {
    if (!c) continue;
    if (looksEmail(c)) m.email ||= c;
    else if (looksPhone(c)) m.phone ||= c;
    else if (!m.name && looksRowNumber(c)) continue;
    else if (!m.name) m.name = c;
    else m.org ||= c;
  }
  return m;
}

/** 2차원 배열 → 명단. 첫 줄이 머리글이면 열 이름으로, 아니면 내용으로 칸을 정한다. */
export function rowsToMembers(rows) {
  if (!rows.length) return [];
  const map = headerMap(rows[0]);
  const body = map ? rows.slice(1) : rows;
  return body
    .map((cells) => {
      const m = map
        ? Object.fromEntries(ROSTER_COLUMNS.map((col) => [col, map[col] === undefined ? '' : (cells[map[col]] || '').trim()]))
        : guessRow(cells);
      m.phone = fixPhone(m.phone);
      return m;
    })
    .filter((m) => ROSTER_COLUMNS.some((col) => m[col]));
}

/** 한 사람의 문제 목록 (빈 줄은 문제 없음) */
export function memberProblems(m, { requirePhone = false } = {}) {
  const problems = {};
  const blank = !ROSTER_COLUMNS.some((col) => String(m[col] || '').trim());
  if (blank) return problems;
  if (!String(m.name || '').trim()) problems.name = '이름이 없습니다';
  const phone = String(m.phone || '').trim();
  if (phone && !/^[0-9+\-()\s]+$/.test(phone)) problems.phone = '숫자와 - 만 쓸 수 있습니다';
  else if (requirePhone && phone.replace(/\D/g, '').length < 9) problems.phone = phone ? '전화번호가 너무 짧습니다' : '본인 확인에 전화번호가 필요합니다';
  const email = String(m.email || '').trim();
  if (email && !EMAIL_RE.test(email)) problems.email = '이메일 형식이 올바르지 않습니다';
  return problems;
}

/** 양식 CSV (엑셀에서 한글이 깨지지 않도록 BOM 포함) */
export function rosterCsvTemplate() {
  return '﻿이름,소속,전화번호,이메일\r\n김교육,1반,010-1234-5678,kim@example.com\r\n이수강,1반,010-2222-3333,lee@example.com\r\n';
}
