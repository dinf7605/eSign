import { api, h, fmtDate, badge, toast } from './common.js';

const progress = (done, total) => h('div', { class: 'progress-cell' },
  h('div', { class: 'progress' }, h('div', { style: { width: `${total ? (done / total) * 100 : 0}%` } })),
  h('span', { class: 'small' }, `${done} / ${total}명`));

const go = (href) => () => { location.href = href; };

try {
  const [groups, docs] = await Promise.all([api('/api/groups'), api('/api/documents')]);

  document.getElementById('groups').replaceChildren(...(groups.length === 0
    ? [h('tr', {}, h('td', { colspan: 3, class: 'empty' }, '아직 없습니다. ', h('a', { href: '/new.html' }, '교육생 서명 요청 만들기 →')))]
    : groups.map((g) => h('tr', { class: 'clickable', onclick: go(`/group.html?id=${encodeURIComponent(g.id)}`) },
      h('td', {}, h('strong', {}, g.title)),
      h('td', {}, progress(g.signed, g.total)),
      h('td', { class: 'muted small hide-sm' }, fmtDate(g.createdAt))))));

  document.getElementById('rows').replaceChildren(...(docs.length === 0
    ? [h('tr', {}, h('td', { colspan: 4, class: 'empty' }, '아직 없습니다.'))]
    : docs.map((d) => h('tr', { class: 'clickable', onclick: go(`/doc.html?id=${encodeURIComponent(d.id)}`) },
      h('td', {}, h('strong', {}, d.title)),
      h('td', {}, badge(d.status)),
      h('td', {}, `${d.signedCount} / ${d.signerCount}명`),
      h('td', { class: 'muted small hide-sm' }, fmtDate(d.createdAt))))));
} catch (err) {
  toast(err.message, 'error');
}
