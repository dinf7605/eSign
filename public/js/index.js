import { api, h, fmtDate, badge, toast, fmtDeadline, dDay } from './common.js';

const progress = (done, total) => h('div', { class: 'progress-cell' },
  h('div', { class: 'progress' }, h('div', { style: { width: `${total ? (done / total) * 100 : 0}%` } })),
  h('span', { class: 'small' }, `${done} / ${total}명`));

const go = (href) => () => { location.href = href; };

if (new URLSearchParams(location.search).has('deleted')) {
  toast('삭제했습니다. 설정 화면의 "파기 기록"에 남았습니다.');
  history.replaceState(null, '', '/');
}

api('/api/retention').then((r) => {
  const soon = r.upcoming.filter((x) => new Date(x.deleteAt).getTime() - Date.now() < 14 * 86400000);
  if (soon.length === 0) return;
  document.getElementById('retention-notice').replaceChildren(h('div', { class: 'result bad', style: { marginTop: 0, marginBottom: '16px' } },
    h('b', {}, `🗄 2주 안에 보관 기간이 끝나 자동 삭제될 요청 ${soon.length}건`),
    h('div', { class: 'small' }, '필요한 명단·서명 PDF는 미리 내려받아 두세요. ', h('a', { href: '/settings.html#retention-form' }, '목록 보기 →'))));
}).catch(() => {});

try {
  const [groups, docs] = await Promise.all([api('/api/groups'), api('/api/documents')]);

  document.getElementById('groups').replaceChildren(...(groups.length === 0
    ? [h('tr', {}, h('td', { colspan: 3, class: 'empty' }, '아직 없습니다. ', h('a', { href: '/new.html' }, '교육생 서명 요청 만들기 →')))]
    : groups.map((g) => h('tr', { class: 'clickable', onclick: go(`/group.html?id=${encodeURIComponent(g.id)}`) },
      h('td', {}, h('strong', {}, g.title),
        g.deadline ? h('div', { class: 'small', style: { color: g.expired ? 'var(--danger)' : '#b35c00' } }, `⏰ ${fmtDeadline(g.deadline)}까지 · ${dDay(g.deadline)}`) : null),
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
