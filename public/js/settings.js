import { api, h, toast, fmtDate } from './common.js';

const $ = (id) => document.getElementById(id);
let data;

const REACH = {
  local: { cls: 'bad', text: '⚠ 지금 주소는 이 PC에서만 열립니다. 메일을 받은 교육생은 열 수 없어요.' },
  private: { cls: 'info', text: '📶 같은 Wi-Fi(내부망)에서만 열리는 주소입니다. 교육장 안에서 서명받을 때 사용하세요.' },
  public: { cls: 'ok', text: '🌐 인터넷에서 열리는 주소입니다. 메일로 어디서든 서명받을 수 있어요.' },
};

function renderLink() {
  const r = REACH[data.current.reach];
  $('link-status').replaceChildren(h('div', { class: `result ${r.cls}`, style: { marginTop: 0 } },
    h('div', {}, '현재 서명 링크 주소: ', h('b', {}, data.current.publicBaseUrl)),
    h('div', {}, r.text),
    data.fixedByServer ? h('div', { class: 'muted' }, '(서버 실행 옵션 PUBLIC_URL로 고정되어 있어 아래 값보다 우선합니다)') : null,
    data.current.temporary ? h('div', { class: 'muted' }, '(npm run start:public 의 인터넷 임시 주소입니다. 아래 값보다 우선하고, 서버를 다시 켜면 바뀝니다)') : null,
    data.tunnel && data.tunnel.status !== 'up'
      ? h('div', {}, data.tunnel.status === 'missing' ? '⚠ cloudflared가 없어 인터넷 공개 주소를 만들 수 없습니다.' : '⏳ 인터넷 공개 주소를 만드는 중… 잠시 뒤 새로고침하세요.')
      : null));
  $('publicUrl').value = data.publicUrl;
  $('lan-urls').textContent = data.lanUrls.length ? `이 PC의 내부 주소: ${data.lanUrls.join(', ')}` : '';
}

function renderMail() {
  const m = data.mail;
  $('preset').replaceChildren(...Object.entries(data.presets).map(([k, p]) => h('option', { value: k }, p.label)));
  $('preset').value = m.preset || 'gmail';
  $('host').value = m.host || '';
  $('port').value = m.port || '';
  $('security').value = m.security || 'ssl';
  $('user').value = m.user || '';
  $('pass').value = '';
  $('pass').placeholder = m.hasPassword ? '저장됨 — 바꿀 때만 입력' : '';
  $('fromName').value = m.fromName || '';
  $('fromEmail').value = m.fromEmail || '';
  $('send-completed-copy').checked = data.sendCompletedCopy !== false;
  if (!m.host) applyPreset();
  updatePresetHelp();
  $('mail-status').replaceChildren(m.host
    ? h('div', { class: 'result ok', style: { marginTop: 0 } }, `✅ 저장된 계정: ${m.fromEmail || m.user} (${m.host}:${m.port})`)
    : h('div', { class: 'result info', style: { marginTop: 0 } }, '아직 메일 계정이 없습니다.'));
}

function renderTsa() {
  const t = data.tsa;
  $('tsa-enabled').checked = t.enabled;
  $('tsa-url').value = t.url || t.defaultUrl;
  const fixed = data.tsaFixedByServer;
  $('tsa-status').replaceChildren(h('div', { class: `result ${fixed || t.enabled ? 'ok' : 'info'}`, style: { marginTop: 0 } },
    fixed ? `✅ 서버 실행 옵션 ESIGN_TSA_URL로 고정: ${fixed} (아래 값보다 우선)`
      : t.enabled ? `✅ 사용 중: ${t.url}` : '꺼져 있음 — 서명 완료 PDF에는 이 PC 시각만 기록됩니다 (PAdES B-B).'));
}

function applyPreset() {
  const p = data.presets[$('preset').value];
  if (p.host) {
    $('host').value = p.host;
    $('port').value = p.port;
    $('security').value = p.security;
  }
}
function updatePresetHelp() {
  const key = $('preset').value;
  $('preset-help').textContent = data.presets[key].help || '';
  $('smtp-fields').hidden = key !== 'custom' && Boolean(data.presets[key].host);
}
$('preset').addEventListener('change', () => { applyPreset(); updatePresetHelp(); });

$('link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/settings', { method: 'POST', body: { publicUrl: $('publicUrl').value } });
    data = { ...data, ...r };
    renderLink();
    toast('서명 링크 주소를 저장했습니다.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('mail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: {
        mail: {
          preset: $('preset').value,
          host: $('host').value.trim(),
          port: Number($('port').value),
          security: $('security').value,
          user: $('user').value.trim(),
          pass: $('pass').value,
          fromName: $('fromName').value.trim(),
          fromEmail: $('fromEmail').value.trim(),
        },
        sendCompletedCopy: $('send-completed-copy').checked,
      },
    });
    data = { ...data, ...r };
    renderMail();
    toast('메일 설정을 저장했습니다. 테스트 메일로 확인해 보세요.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ───── 보관 기간 · 파기 기록 ─────
const MONTH_LABEL = (m) => (m === 0 ? '자동 삭제 안 함' : m % 12 === 0 ? `${m / 12}년` : `${m}개월`);
async function loadRetention() {
  const r = await api('/api/retention');
  $('retention-months').replaceChildren(...r.choices.map((m) => h('option', { value: String(m), selected: m === r.months }, MONTH_LABEL(m))));
  $('retention-upcoming').replaceChildren(r.months === 0
    ? h('div', { class: 'result info', style: { marginTop: 0 } }, '지금은 자동으로 지우지 않습니다. 교육이 끝난 요청은 각 화면에서 직접 지우거나, 보관 기간을 정해 두세요.')
    : r.upcoming.length
      ? h('div', { class: 'result bad', style: { marginTop: 0 } },
        h('b', {}, `30일 안에 자동 삭제될 요청 ${r.upcoming.length}건`),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, ...r.upcoming.map((x) => h('li', {},
          h('a', { href: x.kind === 'group' ? `/group.html?id=${encodeURIComponent(x.id)}` : `/doc.html?id=${encodeURIComponent(x.id)}` }, x.title),
          ` — ${fmtDate(x.deleteAt)}`))))
      : h('div', { class: 'result ok', style: { marginTop: 0 } }, `✅ 보관 기간 ${MONTH_LABEL(r.months)} · 30일 안에 자동 삭제될 요청은 없습니다.`));
  $('deletions').replaceChildren(r.deletions.length
    ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '삭제 시각'), h('th', {}, '제목'), h('th', {}, '인원'), h('th', {}, '이유'))),
      h('tbody', {}, ...r.deletions.map((d) => h('tr', {},
        h('td', {}, fmtDate(d.at)),
        h('td', {}, d.title, h('div', { class: 'muted' }, `${d.kind === 'group' ? '교육생 일괄' : '개별 문서'} · 만든 날 ${fmtDate(d.createdAt)}`)),
        h('td', {}, `${d.people}명 (서명 ${d.signed})`),
        h('td', {}, d.reason === 'auto' ? '보관 기간 만료' : '직접 삭제')))))
    : h('div', { class: 'muted' }, '아직 없습니다.'));
}

$('retention-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const months = Number($('retention-months').value);
  if (months && !window.confirm(`보관 기간을 ${MONTH_LABEL(months)}으로 정할까요?\n이미 기간이 지난 요청은 1분 안에 자동으로 영구 삭제됩니다.`)) return;
  try {
    await api('/api/settings', { method: 'POST', body: { retentionMonths: months } });
    toast(months ? `보관 기간을 ${MONTH_LABEL(months)}으로 정했습니다.` : '자동 삭제를 껐습니다.');
    loadRetention();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('tsa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/settings', { method: 'POST', body: { tsa: { enabled: $('tsa-enabled').checked, url: $('tsa-url').value.trim() } } });
    data = { ...data, ...r };
    renderTsa();
    toast($('tsa-enabled').checked ? '타임스탬프를 켰습니다. "연결 테스트"로 확인해 보세요.' : '타임스탬프를 껐습니다.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('tsa-test').addEventListener('click', async () => {
  const btn = $('tsa-test');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  try {
    const r = await api('/api/settings/test-tsa', { method: 'POST', body: { url: $('tsa-url').value.trim() } });
    const when = new Date(r.genTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    toast(`연결 성공: ${r.tsa || 'TSA'} · ${when}${r.trusted ? '' : ' (공인 루트에 연결되지 않는 인증서)'}`, r.trusted ? '' : 'error');
  } catch (err) {
    toast(`연결 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '연결 테스트';
  }
});

$('test-send').addEventListener('click', async () => {
  const to = $('test-to').value.trim();
  if (!to) return toast('테스트 메일을 받을 주소를 입력해 주세요.', 'error');
  const btn = $('test-send');
  btn.disabled = true;
  btn.textContent = '보내는 중…';
  try {
    await api('/api/settings/test-mail', { method: 'POST', body: { to } });
    toast(`${to} 로 테스트 메일을 보냈습니다. 받은편지함(스팸함 포함)을 확인해 주세요.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '테스트 메일 보내기';
  }
  return undefined;
});

try {
  data = await api('/api/settings');
  renderLink();
  renderMail();
  renderTsa();
  await loadRetention();
} catch (err) {
  toast(err.message, 'error');
}
