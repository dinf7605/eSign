import { api, h, fmtDate, badge, toast, copyText, COLORS, EVENT_LABEL, FIELD_TYPES, placeBox, hexToRgba } from './common.js';
import { renderPdf } from './pdfview.js';

const params = new URLSearchParams(location.search);
const id = params.get('id');
const content = document.getElementById('content');
let shownPreviewFor = null; // 미리보기는 상태가 바뀔 때만 다시 그림

async function load() {
  let doc;
  try {
    doc = await api(`/api/documents/${encodeURIComponent(id || '')}`);
  } catch (err) {
    content.replaceChildren(h('div', { class: 'card center-msg' }, h('div', { class: 'icon' }, '📄'), err.message));
    return;
  }
  render(doc);
  if (shownPreviewFor !== doc.status) {
    shownPreviewFor = doc.status;
    renderPreview(doc);
  }
  if (doc.status === 'pending' || doc.status === 'finalizing') setTimeout(load, 4000);
}

const colorFor = (doc, signerId) => COLORS[doc.signers.findIndex((s) => s.id === signerId) % COLORS.length];

function render(doc) {
  const colorOf = (signerId) => colorFor(doc, signerId);
  const base = `/api/documents/${encodeURIComponent(doc.id)}`;

  const header = h('div', { class: 'row spread', style: { marginBottom: '18px' } },
    h('div', { class: 'grow' },
      h('div', { class: 'row', style: { gap: '10px' } }, h('h1', {}, doc.title), badge(doc.status)),
      h('p', { class: 'sub', style: { margin: 0 } }, `${doc.fileName} · ${doc.pageCount}쪽 · 요청 ${fmtDate(doc.createdAt)}`)),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `${base}/original.pdf?download` }, '원본 PDF'),
      doc.status === 'completed' ? h('a', { class: 'btn btn-primary', href: `${base}/completed.pdf?download` }, '⬇ 서명 완료 PDF') : null));

  const notice = params.has('created') && doc.status === 'pending'
    ? h('div', { class: 'result info', style: { marginTop: 0, marginBottom: '18px' } },
      h('h3', {}, '서명 요청이 만들어졌습니다 🎉'),
      h('div', { class: 'small' }, '아래 서명자별 링크를 복사해서 카카오톡·문자·메일로 보내 주세요. (MVP라 자동 발송은 아직 없습니다)'))
    : null;

  const signers = h('div', { class: 'card' },
    h('h2', {}, `서명자 (${doc.signers.filter((s) => s.status === 'signed').length}/${doc.signers.length} 완료)`),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '서명자'), h('th', {}, '상태'), h('th', {}, '서명 링크'))),
      h('tbody', {}, ...doc.signers.map((s) => {
        const link = s.signLink || new URL(s.signPath, location.origin).href;
        return h('tr', {},
          h('td', {}, h('div', { class: 'row', style: { gap: '8px' } },
            h('span', { class: 'dot', style: { background: colorOf(s.id) } }),
            h('div', {}, h('strong', {}, s.name), s.email ? h('div', { class: 'small muted' }, s.email) : null))),
          h('td', {}, badge(s.status === 'signed' ? 'signed' : 'pending'),
            h('div', { class: 'small muted' }, s.signedAt ? fmtDate(s.signedAt) : s.viewedAt ? `열람 ${fmtDate(s.viewedAt)}` : '아직 열람 안 함')),
          h('td', { style: { width: '46%' } }, s.status === 'signed'
            ? h('span', { class: 'small muted' }, '서명 완료')
            : h('div', { class: 'link-box' },
              h('input', { type: 'text', readonly: true, value: link, onfocus: (e) => e.target.select() }),
              h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(link) }, '복사'),
              h('a', { class: 'btn btn-sm', href: link, target: '_blank', rel: 'noopener' }, '열기'))));
      }))));

  const integrity = h('div', { class: 'card' },
    h('h2', {}, '무결성 정보 (SHA-256)'),
    h('div', { class: 'small muted' }, '원본 PDF'),
    h('div', { class: 'mono', style: { marginBottom: '10px' } }, doc.originalHash),
    h('div', { class: 'small muted' }, '서명 완료 PDF'),
    h('div', { class: 'mono', style: { marginBottom: '10px' } }, doc.completedHash || '모든 서명이 끝나면 생성됩니다'),
    h('div', { class: 'small muted' }, 'PDF 전자서명(봉인)'),
    h('div', { class: 'small' }, doc.seal
      ? [`✅ ${doc.seal.format} · ${doc.seal.subject} 인증서로 서명됨 — `, h('a', { href: '/verify.html' }, '검증하기')]
      : doc.status === 'completed'
        ? '없음 (전자서명 기능을 넣기 전에 완료된 문서)'
        : '모든 서명이 끝나면 최종 PDF 전체에 전자서명이 들어갑니다'));

  const events = h('div', { class: 'card' },
    h('h2', {}, '이력'),
    h('ul', { class: 'timeline' }, ...doc.events.slice().reverse().map((e) => h('li', {},
      h('time', {}, fmtDate(e.at)),
      h('span', {}, EVENT_LABEL[e.type] || e.type, e.name ? h('b', {}, ` · ${e.name}`) : null,
        e.ip ? h('span', { class: 'muted small' }, ` (IP ${e.ip})`) : null,
        e.detail ? h('div', { class: 'muted small' }, e.detail) : null)))));

  const back = doc.groupId
    ? h('a', { href: `/group.html?id=${encodeURIComponent(doc.groupId)}`, class: 'small', style: { display: 'inline-block', marginBottom: '10px' } }, '← 교육생 서명 현황으로')
    : '';
  content.replaceChildren(back, header, notice || '', signers, integrity, events);
}

async function renderPreview(doc) {
  const card = document.getElementById('preview-card');
  card.hidden = false;
  const done = doc.status === 'completed';
  document.getElementById('preview-title').textContent = done ? '서명 완료 문서 (감사 추적 인증서 포함)' : '문서 미리보기 · 서명란 위치';
  try {
    const { pages } = await renderPdf(document.getElementById('pages'),
      `/api/documents/${encodeURIComponent(doc.id)}/${done ? 'completed' : 'original'}.pdf`);
    if (done) return;
    for (const f of doc.fields) {
      const signer = doc.signers.find((s) => s.id === f.signerId);
      const color = colorFor(doc, f.signerId);
      const box = h('div', { class: 'sig-box', style: { borderColor: color, color, background: hexToRgba(color, 0.1) } },
        h('span', { class: 'label' }, `${signer.name} ${FIELD_TYPES[f.type]?.short || ''}${signer.status === 'signed' ? ' ✓' : ''}`));
      placeBox(box, f);
      pages[f.page - 1]?.overlay.append(box);
    }
  } catch (err) {
    console.error(err);
    toast('미리보기를 불러오지 못했습니다.', 'error');
  }
}

load();
