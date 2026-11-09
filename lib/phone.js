'use strict';
// 전화번호 정규화 (본인 확인 비교·명단 출력에서 함께 사용)

/** 숫자만 남기고 +82 10… → 010… */
function normalizePhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('82') && d.length >= 11) d = `0${d.slice(2)}`;
  return d;
}

/** 인쇄용 연락처 가리기: 010-1234-5678 → 010-****-5678, 02-123-4567 → 02-****-4567 */
function maskPhone(phone) {
  const d = normalizePhone(phone);
  if (!d) return '';
  if (d.length < 8) return '***';
  const head = d.startsWith('02') ? 2 : 3;
  return `${d.slice(0, head)}-****-${d.slice(-4)}`;
}

module.exports = { normalizePhone, maskPhone };
