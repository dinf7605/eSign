import { api, h, fmtDate, toast, copyText, parseMemberList } from './common.js';

const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const base = `/api/groups/${encodeURIComponent(id)}`;
const $ = (el) => document.getElementById(el);
let group;
let timer;

/** 서명 링크를 이 기기(관리자 화면)에서 여는 주소 — 서명이 끝나면 이 현황으로 돌아옴 */
const hereLink = (m) => {
  const u = new URL(m.signLink);
  return `${u.pathname}${u.search}&return=${encodeURIComponent(location.pathname + location.search.replace(/&?created=1/, ''))}`;
};

async function load() {
  clearTimeout(timer);
  try {
    group = await api(base);
  } catch (err) {
    $('head').replaceChildren(h('div', { class: 'card center-msg' }, h('div', { class: 'icon' }, '📄'), err.message));
    return;
  }
  renderHead();
  renderMail();
  renderRows();
  // 메일 발송 중이면 자주, 아니면 5초마다 새로고침
  timer = setTimeout(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load(); else timer = setTimeout(load, 2000); },
    group.mail.sending?.running ? 1500 : 5000);
}

function renderHead() {
  const { total, signed } = group.counts;
  const pct = total ? Math.round((signed / total) * 100) : 0;
  $('head').replaceChildren(...[
    h('div', { style: { marginBottom: '14px' } },
      h('h1', {}, group.title),
      group.info ? h('p', { class: 'sub pre', style: { margin: '0 0 4px' } }, group.info) : null,
      h('p', { class: 'small muted', style: { margin: 0 } },
        `${group.fileName} · ${group.pageCount}쪽 · 만든 날 ${fmtDate(group.createdAt)} · `,
        group.requireVerification ? '🔐 이름+전화번호 본인 확인 사용' : '본인 확인 없음 (링크만으로 서명)'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: { marginTop: '6px', paddingLeft: 0 }, onclick: saveAsTemplate, title: '다음 기수에 같은 문서·칸 배치를 다시 쓰려면' }, '💾 템플릿으로 저장')),
    params.has('created') ? h('div', { class: 'result info', style: { marginTop: 0, marginBottom: '16px' } },
      h('h3', {}, `교육생 ${total}명의 서명 요청이 만들어졌습니다 🎉`),
      h('div', { class: 'small' }, '아래 "메일 보내기"로 교육생마다 개인 서명 링크를 보내세요. 현장에서는 QR이나 "이 기기에서"로도 받을 수 있습니다.')) : null,
    h('div', { class: 'card' },
      h('div', { class: 'row spread', style: { alignItems: 'flex-start' } },
        h('div', { class: 'grow', style: { minWidth: '220px' } },
          h('div', { class: 'row', style: { gap: '10px', marginBottom: '8px' } },
            h('strong', { style: { fontSize: '22px' } }, `${signed} / ${total}명`),
            h('span', { class: 'muted' }, `서명 완료 (${pct}%)`)),
          h('div', { class: 'progress big' }, h('div', { style: { width: `${pct}%` } }))),
        h('div', { class: 'output-box' },
          h('div', { class: 'small muted', style: { marginBottom: '6px' } }, '📋 서명한 사람 명단'),
          h('div', { class: 'row', style: { gap: '6px' } },
            h('a', { class: 'btn btn-primary', href: `${base}/roster.xlsx` }, '명단 엑셀'),
            h('a', { class: 'btn btn-primary', href: `${base}/roster.pdf?download` }, '명단 PDF'),
            h('a', { class: 'btn', href: `${base}/roster.pdf`, target: '_blank', rel: 'noopener' }, '미리보기')))),
      h('details', { class: 'small more-outputs' },
        h('summary', {}, '다른 내려받기'),
        h('div', { class: 'row', style: { gap: '6px', marginTop: '8px' } },
          h('a', { class: 'btn btn-sm', href: `${base}/roster.xlsx?all` }, '전체 현황 엑셀 (미서명 포함)'),
          h('a', { class: 'btn btn-sm', href: `${base}/roster.pdf?all&download` }, '전체 현황 PDF'),
          signed ? h('a', { class: 'btn btn-sm', href: `${base}/signed.zip` }, '개인별 서명 PDF 전체 (ZIP)') : null),
        h('p', { class: 'muted', style: { margin: '8px 0 0' } },
          '명단 엑셀에는 이름·소속·연락처·이메일·서명 일시·본인 확인 기록이 들어가고, 명단 PDF에는 서명 이미지가 함께 들어갑니다(연락처 일부 가림, 전자서명 포함).'))),
  ].filter(Boolean));
}

/** 이 요청의 문서와 칸 배치를 다음 기수에 다시 쓰도록 템플릿으로 저장 */
async function saveAsTemplate() {
  const name = window.prompt('템플릿 이름 (새 서명 요청 화면에서 이 이름으로 불러옵니다)', group.title);
  if (name === null) return;
  try {
    const t = await api(`${base}/template`, { method: 'POST', body: { name } });
    toast(`템플릿 "${t.name}"을(를) 저장했습니다. "새 서명 요청"에서 불러올 수 있습니다.`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

const REACH_MSG = {
  local: '서명 링크 주소가 이 PC 전용(localhost)이라 메일을 받은 교육생이 열 수 없습니다.',
  private: '서명 링크가 같은 Wi-Fi(내부망) 주소입니다. 교육장 밖(집 등)에서는 열리지 않아요.',
};

function renderMail() {
  const m = group.mail;
  const job = m.sending;
  const reach = group.link.reach;
  const unsent = group.members.filter((x) => !x.signed && x.email && x.emailStatus !== 'sent').length;
  const unsignedWithEmail = group.members.filter((x) => !x.signed && x.email).length;
  const blocked = !m.configured || reach === 'local';

  const notices = [];
  if (!m.configured) notices.push(h('div', { class: 'result bad', style: { marginTop: 0 } }, '메일 발송 계정이 없습니다. ', h('a', { href: '/settings.html' }, '설정에서 등록하기 →')));
  const tunnel = group.link.tunnel;
  if (group.link.temporary) {
    notices.push(h('div', { class: 'result info', style: { marginTop: notices.length ? '8px' : 0 } },
      '🌐 인터넷 임시 주소로 링크가 나갑니다: ', h('code', {}, group.link.base),
      h('div', { class: 'small' }, '서명이 끝날 때까지 서버 창과 PC를 켜 두세요. 서버를 다시 켜면 주소가 바뀌어 이미 보낸 링크가 열리지 않으니, 다시 켠 뒤 "미서명자에게 다시 알림"을 누르세요.')));
  } else if (tunnel && tunnel.status !== 'up') {
    notices.push(h('div', { class: 'result bad', style: { marginTop: notices.length ? '8px' : 0 } },
      tunnel.status === 'missing'
        ? '인터넷 공개 모드인데 cloudflared 프로그램이 없습니다. 설치 후 서버를 다시 켜세요: winget install --id Cloudflare.cloudflared'
        : `인터넷 공개 주소를 만드는 중이거나 끊겼습니다${tunnel.error ? ` (${tunnel.error})` : ''}. 잠시 뒤 새로고침하세요.`));
  }
  if (REACH_MSG[reach] && !(tunnel && reach === 'local')) {
    notices.push(h('div', { class: `result ${reach === 'local' ? 'bad' : 'info'}`, style: { marginTop: notices.length ? '8px' : 0 } },
      REACH_MSG[reach], ' 지금 링크: ', h('code', {}, group.link.base), ' ', h('a', { href: '/settings.html' }, '서명 링크 주소 설정 →')));
  }

  $('mail').replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row spread' },
      h('div', {},
        h('h2', { style: { margin: '0 0 4px' } }, '✉️ 서명 요청 메일'),
        h('div', { class: 'small muted' },
          `보냄 ${m.sent}명 · 실패 ${m.failed}명 · 안 보냄 ${unsent}명 · 이메일 없음 ${m.noEmail}명`)),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: blocked || job?.running || unsent === 0, onclick: () => send('unsent') },
          unsent ? `안 보낸 ${unsent}명에게 메일 보내기` : '모두 보냈습니다'),
        h('button', { type: 'button', class: 'btn', disabled: blocked || job?.running || unsignedWithEmail === 0, onclick: () => send('unsigned') },
          `미서명 ${unsignedWithEmail}명에게 다시 알림`))),
    job ? h('div', { style: { marginTop: '12px' } },
      h('div', { class: 'small', style: { marginBottom: '4px' } }, job.running
        ? `보내는 중… ${job.done} / ${job.total}`
        : `마지막 발송: ${job.total}명 중 성공 ${job.sent} · 실패 ${job.failed} (${fmtDate(job.finishedAt)})`),
      h('div', { class: 'progress' }, h('div', { style: { width: `${(job.done / job.total) * 100}%`, background: job.failed ? 'var(--warn)' : '' } })),
      !job.running && job.lastError ? h('div', { class: 'small', style: { color: 'var(--danger)', marginTop: '4px' } }, `실패 이유 예: ${job.lastError}`) : null) : null,
    notices.length ? h('div', { style: { marginTop: '12px' } }, ...notices) : null));
}

async function send(scope, member) {
  const n = scope === 'one' ? 1 : scope === 'unsent'
    ? group.members.filter((x) => !x.signed && x.email && x.emailStatus !== 'sent').length
    : group.members.filter((x) => !x.signed && x.email).length;
  const what = scope === 'one' ? `${member.name} 님(${member.email})에게` : `${n}명에게`;
  if (!window.confirm(`${what} 서명 요청 메일을 보낼까요?\n링크: ${group.link.base}`)) return;
  try {
    await api(`${base}/send`, { method: 'POST', body: { scope, docId: member?.docId } });
    toast('메일을 보내기 시작했습니다.');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function mailCell(m) {
  if (!m.email) return h('span', { class: 'small muted' }, '이메일 없음');
  const addr = h('div', { class: 'small muted ellipsis', title: m.email }, m.email);
  if (m.emailStatus === 'sent') return [h('span', { class: 'badge badge-signed' }, '보냄'), addr, h('div', { class: 'small muted' }, fmtDate(m.emailSentAt))];
  if (m.emailStatus === 'failed') return [h('span', { class: 'badge badge-failed' }, '실패'), addr, h('div', { class: 'small', style: { color: 'var(--danger)' } }, m.emailError)];
  return [h('span', { class: 'badge badge-pending' }, '안 보냄'), addr];
}

function statusCell(m) {
  if (m.signed) return [h('span', { class: 'badge badge-signed' }, '서명 완료'), h('div', { class: 'small muted' }, fmtDate(m.signedAt))];
  return [
    h('span', { class: 'badge badge-pending' }, '미서명'),
    h('div', { class: 'small muted' }, m.verifiedAt ? `본인 확인 ${fmtDate(m.verifiedAt)}` : m.viewedAt ? `열람 ${fmtDate(m.viewedAt)}` : '아직 안 열어봄'),
  ];
}

function renderRows() {
  const q = $('search').value.trim().toLowerCase();
  const filter = $('filter').value;
  const rows = group.members.filter((m) => {
    if (filter === 'signed' && !m.signed) return false;
    if (filter === 'pending' && m.signed) return false;
    if (filter === 'mailfail' && m.emailStatus !== 'failed') return false;
    return !q || `${m.name} ${m.org} ${m.email}`.toLowerCase().includes(q);
  });
  $('count').textContent = `${group.counts.total}명`;
  const canMail = group.mail.configured && group.link.reach !== 'local' && !group.mail.sending?.running;

  $('rows').replaceChildren(...(rows.length === 0
    ? [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, group.members.length ? '조건에 맞는 교육생이 없습니다.' : '교육생이 없습니다.'))]
    : rows.map((m) => h('tr', {},
      h('td', { class: 'muted' }, m.no),
      h('td', {}, h('strong', {}, m.name), m.org ? h('span', { class: 'muted small' }, ` · ${m.org}`) : null,
        m.phone ? h('div', { class: 'small muted' }, m.phone) : null),
      h('td', {}, statusCell(m)),
      h('td', { class: 'mail-cell' }, mailCell(m)),
      h('td', { class: 'actions' }, m.signed
        ? [
          h('a', { class: 'btn btn-sm', href: `/api/documents/${m.docId}/completed.pdf`, target: '_blank', rel: 'noopener' }, '서명 PDF'),
          h('a', { class: 'btn btn-sm btn-ghost', href: `/doc.html?id=${m.docId}` }, '이력'),
        ]
        : [
          m.email ? h('button', { type: 'button', class: 'btn btn-sm', disabled: !canMail, onclick: () => send('one', m) }, m.emailStatus === 'sent' ? '메일 다시' : '메일') : null,
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openQr(m) }, 'QR'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(m.signLink) }, '링크'),
          h('a', { class: 'btn btn-sm btn-primary', href: hereLink(m) }, '이 기기에서'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => openEdit(m) }, '수정'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger-text', title: '서명 요청 취소', onclick: () => cancel(m) }, '취소'),
        ])))));
}

$('search').addEventListener('input', renderRows);
$('filter').addEventListener('change', renderRows);

// ───── QR ─────
function openQr(m) {
  $('qr-name').textContent = `${m.no}. ${m.name}${m.org ? ` (${m.org})` : ''}`;
  $('qr-img').src = `/api/documents/${m.docId}/signers/${m.signerId}/qr.svg`;
  $('qr-link').value = m.signLink;
  $('qr-here').href = hereLink(m);
  $('qr-copy').onclick = () => copyText(m.signLink);
  $('qr-dialog').showModal();
}
$('qr-close').addEventListener('click', () => $('qr-dialog').close());

// ───── 수정 ─────
let editing;
function openEdit(m) {
  editing = m;
  $('e-name').value = m.name;
  $('e-org').value = m.org;
  $('e-phone').value = m.phone;
  $('e-email').value = m.email;
  $('e-phone').required = group.requireVerification;
  $('edit-dialog').showModal();
}
$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    group = await api(`${base}/members/${editing.docId}`, {
      method: 'POST',
      body: { name: $('e-name').value, org: $('e-org').value, phone: $('e-phone').value, email: $('e-email').value },
    });
    $('edit-dialog').close();
    toast('수정했습니다.');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ───── 취소 / 추가 / 링크 전체 복사 ─────
async function cancel(m) {
  if (!window.confirm(`${m.name} 님의 서명 요청을 취소할까요?\n취소하면 이 사람의 서명 링크는 더 이상 열리지 않고, 명단에서도 빠집니다.`)) return;
  try {
    group = await api(`${base}/members/${m.docId}/cancel`, { method: 'POST', body: {} });
    toast(`${m.name} 님의 요청을 취소했습니다.`);
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('toggle-add').addEventListener('click', () => {
  $('add-box').hidden = !$('add-box').hidden;
  if (!$('add-box').hidden) $('add-text').focus();
});
$('add-text').addEventListener('input', () => {
  const list = parseMemberList($('add-text').value);
  $('add-preview').textContent = list.length ? `${list.length}명 인식: ${list.slice(0, 4).map((m) => m.name).join(', ')}${list.length > 4 ? ' …' : ''}` : '';
});
$('add-submit').addEventListener('click', async () => {
  const members = parseMemberList($('add-text').value);
  if (!members.length) return toast('추가할 교육생을 입력해 주세요.', 'error');
  try {
    group = await api(`${base}/members`, { method: 'POST', body: { members } });
    $('add-text').value = '';
    $('add-preview').textContent = '';
    $('add-box').hidden = true;
    toast(`${members.length}명을 추가했습니다. 메일 보내기를 눌러 링크를 보내세요.`);
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
  return undefined;
});

$('copy-all').addEventListener('click', () => {
  const pending = group.members.filter((m) => !m.signed);
  if (!pending.length) return toast('미서명 교육생이 없습니다.');
  // 엑셀·카카오톡에 붙여넣기 좋은 "이름<탭>링크" 형식
  copyText(pending.map((m) => `${m.name}${m.org ? `(${m.org})` : ''}\t${m.signLink}`).join('\n'));
  return undefined;
});

load();
