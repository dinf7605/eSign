import { api, h, fmtDate, sha256Hex, bytesToBase64 } from './common.js';

const $ = (id) => document.getElementById(id);
const drop = $('drop');

$('file').addEventListener('change', (e) => check(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  check(e.dataTransfer.files[0]);
});

api('/api/seal')
  .then((s) => { $('ca-fp').textContent = `봉인 인증서: ${s.subject} · 발급: ${s.issuer} · 유효 ~${fmtDate(s.validTo)}`; })
  .catch(() => {});

const kv = (label, value) => h('div', { class: 'small' }, h('span', { class: 'muted' }, `${label}: `), value);

function signatureCard(s) {
  if (!s.signed) {
    return h('div', { class: 'result bad' },
      h('h3', {}, '① 전자서명 — 없음'),
      h('div', {}, '이 PDF에는 전자서명이 들어 있지 않습니다.'));
  }
  const last = s.signatures[s.signatures.length - 1];
  const ts = last.timestamp;
  const pades = last.subFilter === 'ETSI.CAdES.detached';
  const details = [
    last.signer ? kv('서명 인증서', `${last.signer.subject} (발급: ${last.signer.issuer})`) : null,
    ts?.valid
      ? kv('서명 시각', `${fmtDate(ts.genTime)} — 타임스탬프로 확인됨 (${ts.tsa}${ts.trusted ? '' : ', 인증서 신뢰 확인 안 됨'})`)
      : last.signingTime ? kv('서명 시각', `${fmtDate(last.signingTime)} (서명한 서버의 시계 기준${ts ? '' : ' · 타임스탬프 없음'})`) : null,
    ts && !ts.valid ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, `⚠ 타임스탬프 검증 실패: ${ts.errors.join(' / ')}`) : null,
    last.reason ? kv('사유', last.reason) : null,
    kv('형식', pades ? `PAdES ${ts?.valid ? 'B-T (타임스탬프 포함)' : 'B-B'} (ETSI.CAdES.detached)` : last.subFilter || '알 수 없음'),
    last.signer ? h('div', { class: 'mono muted', style: { marginTop: '4px' } }, `인증서 지문 ${last.signer.fingerprint256}`) : null,
  ];

  if (s.valid && s.trusted) {
    return h('div', { class: 'result ok' },
      h('h3', {}, '① 전자서명 ✅ 유효 — 서명 이후 변경되지 않았습니다'), ...details);
  }
  if (s.valid) {
    return h('div', { class: 'result info' },
      h('h3', {}, '① 전자서명 ⚠️ 서명은 유효하지만, 이 서비스가 신뢰하는 인증서가 아닙니다'),
      h('div', { class: 'small' }, '문서는 서명 이후 바뀌지 않았지만, 누가 서명했는지는 보장할 수 없습니다.'), ...details);
  }
  const errors = [...new Set(s.signatures.flatMap((x) => x.errors))];
  if (s.modifiedAfterSigning) errors.unshift('서명 이후 파일 끝에 내용이 추가·수정되었습니다.');
  return h('div', { class: 'result bad' },
    h('h3', {}, '① 전자서명 ❌ 검증 실패'),
    h('ul', { style: { margin: '4px 0 8px', paddingLeft: '20px' } }, ...errors.map((e) => h('li', {}, e))),
    ...details);
}

function registryCard(r, hash, fileName) {
  const hashLine = h('div', { class: 'mono muted', style: { marginTop: '8px' } }, `${fileName} · SHA-256 ${hash}`);
  if (r.match === 'completed') {
    return h('div', { class: 'result ok' },
      h('h3', {}, '② 등록 문서 대조 ✅ 이 서비스에서 서명 완료된 문서와 정확히 같습니다'),
      h('div', {}, h('b', {}, r.title), ` · 완료 ${fmtDate(r.completedAt)}`),
      h('ul', { style: { margin: '8px 0 0', paddingLeft: '20px' } },
        ...r.signers.map((s) => h('li', {}, `${s.name} — ${fmtDate(s.signedAt)} 서명`))),
      hashLine);
  }
  if (r.match === 'original') {
    return h('div', { class: 'result info' },
      h('h3', {}, '② 등록 문서 대조 ℹ️ 서명 전 원본 문서입니다'),
      h('div', {}, `"${r.title}" 문서의 원본과 같습니다. 서명이 들어간 최종본이 아닙니다.`),
      hashLine);
  }
  return h('div', { class: 'result bad' },
    h('h3', {}, '② 등록 문서 대조 ❌ 일치하는 문서가 없습니다'),
    h('div', {}, '서명 완료 후 내용이 바뀌었거나, 이 서비스에서 만든 문서가 아닙니다.'),
    hashLine);
}

async function check(file) {
  if (!file) return;
  const result = $('result');
  result.replaceChildren(h('div', { class: 'result info' }, '확인 중…'));
  try {
    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer);
    const [registry, signature] = await Promise.all([
      api('/api/verify', { method: 'POST', body: { hash } }),
      api('/api/verify-signature', { method: 'POST', body: { pdfBase64: bytesToBase64(new Uint8Array(buffer)) } }),
    ]);
    result.replaceChildren(signatureCard(signature), registryCard(registry, hash, file.name));
  } catch (err) {
    result.replaceChildren(h('div', { class: 'result bad' }, err.message));
  } finally {
    $('file').value = '';
  }
}
