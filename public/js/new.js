import { api, h, COLORS, FIELD_TYPES, isInputType, toast, fmtDate, bytesToBase64, placeBox, hexToRgba, parseMemberList } from './common.js';
import { renderPdf } from './pdfview.js';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_SIGNERS = 10;
const MAX_MEMBERS = 500;
const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

const state = {
  mode: 'group', // 'group' = 교육생 일괄(1인 1부), 'multi' = 한 문서에 여러 명
  fileName: '',
  pdfBase64: '',
  pages: [],
  signers: [{ name: '', email: '' }],
  members: [],
  fields: [], // { type, signerIndex, page, x, y, w, h } — 좌표는 페이지 대비 비율(0~1)
  activeSigner: 0,
  activeType: 'signature',
};

const nameOf = (i) => state.signers[i]?.name.trim() || `서명자 ${i + 1}`;
const colorOf = (f) => (state.mode === 'group' ? FIELD_TYPES[f.type].color : COLORS[f.signerIndex % COLORS.length]);
const labelOf = (f) => {
  if (f.type === 'checkbox') return '✓';
  if (f.type === 'text') return f.label || '입력란';
  return state.mode === 'group'
    ? (f.type === 'signature' ? '교육생 서명' : `${FIELD_TYPES[f.type].short} 자동 입력`)
    : `${nameOf(f.signerIndex)} ${FIELD_TYPES[f.type].short}`;
};
const DEFAULT_LABEL = { checkbox: '동의 항목', text: '입력란' };

// ───── 0) 요청 방식 ─────
function setMode(mode) {
  state.mode = mode;
  for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const el of document.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== mode;
  $('title-label').textContent = mode === 'group' ? '교육명 (서명부 제목)' : '문서 제목';
  renderAll();
}
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

// ───── 1) PDF 올리기 ─────
const drop = $('drop');
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('PDF 파일만 올릴 수 있습니다.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    toast('PDF는 15MB 이하만 올릴 수 있습니다.', 'error');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!$('title').value) $('title').value = file.name.replace(/\.pdf$/i, '');
  await openPdf(bytes, file.name, `선택한 파일: ${file.name} (${(file.size / 1024).toFixed(0)} KB) — 다른 파일을 고르면 서명란이 초기화됩니다.`);
}

/** PDF를 편집기에 연다. 칸은 비운다. 성공하면 true */
async function openPdf(bytes, fileName, note) {
  state.fileName = fileName;
  state.pdfBase64 = bytesToBase64(bytes);
  state.fields = [];
  $('file-name').hidden = false;
  $('file-name').textContent = note;
  $('editor').hidden = false;

  try {
    const { pages } = await renderPdf($('pages'), bytes);
    state.pages = pages;
    pages.forEach(setupPage);
    renderSigners();
    renderAll();
    $('editor').scrollIntoView({ behavior: 'smooth' });
    return true;
  } catch (err) {
    console.error(err);
    $('pages').replaceChildren(h('div', { class: 'loading' }, 'PDF를 열 수 없습니다. 손상되었거나 암호가 걸린 파일인지 확인해 주세요.'));
    state.pdfBase64 = '';
    return false;
  }
}

// ───── 템플릿: 불러오기 / 이름 바꾸기 / 지우기 / 저장 ─────
async function loadTemplates() {
  let list;
  try {
    list = await api('/api/templates');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  $('templates').hidden = list.length === 0;
  $('template-list').replaceChildren(...list.map((t) => h('div', { class: 'template-item' },
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'template-name' }, t.name),
      h('div', { class: 'small muted' }, [
        t.mode === 'group' ? '교육생 일괄' : `한 문서에 ${t.signerCount}명`,
        `${t.pageCount}쪽`,
        `칸 ${t.fieldCount}개`,
        t.inputLabels.length ? `체크·입력: ${t.inputLabels.slice(0, 3).join(', ')}${t.inputLabels.length > 3 ? ' …' : ''}` : null,
        fmtDate(t.updatedAt || t.createdAt),
      ].filter(Boolean).join(' · '))),
    h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => useTemplate(t.id) }, '불러오기'),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => renameTemplate(t) }, '이름 변경'),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text', onclick: () => deleteTemplate(t) }, '삭제'))));
}

async function useTemplate(id) {
  if (state.pdfBase64 && !window.confirm('지금 편집 중인 문서와 칸 배치를 템플릿으로 바꿀까요?')) return;
  try {
    const t = await api(`/api/templates/${encodeURIComponent(id)}`);
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}/document.pdf`);
    if (!res.ok) throw new Error('템플릿 문서를 불러오지 못했습니다.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    setMode(t.mode);
    if (t.mode === 'multi') {
      state.signers = Array.from({ length: t.signerCount }, (_, i) => state.signers[i] || { name: '', email: '' });
      state.activeSigner = 0;
    }
    $('title').value = t.name;
    if (t.mode === 'group') {
      $('info').value = t.info || '';
      $('require-verification').checked = t.requireVerification;
    }
    const ok = await openPdf(bytes, t.fileName, `템플릿 "${t.name}" — ${t.fileName} · ${t.pageCount}쪽. 칸은 그대로 옮겨 놓았고, 필요하면 고칠 수 있습니다.`);
    if (!ok) return;
    state.fields = t.fields.map((f) => ({ ...f, signerIndex: f.signerIndex ?? 0 }));
    renderSigners();
    renderAll();
    renderMembersPreview();
    toast(t.mode === 'group' ? `템플릿을 불러왔습니다. 교육명을 고치고 명단을 넣어 주세요.` : '템플릿을 불러왔습니다. 서명자 이름을 넣어 주세요.');
    (t.mode === 'group' ? $('members') : $('signers').querySelector('input'))?.focus({ preventScroll: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameTemplate(t) {
  const name = window.prompt('템플릿 이름', t.name);
  if (name === null || name.trim() === t.name) return;
  try {
    await api(`/api/templates/${encodeURIComponent(t.id)}`, { method: 'POST', body: { name } });
    toast('이름을 바꿨습니다.');
    loadTemplates();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteTemplate(t) {
  if (!window.confirm(`템플릿 "${t.name}"을(를) 지울까요?\n이미 만든 서명 요청에는 영향이 없습니다.`)) return;
  try {
    await api(`/api/templates/${encodeURIComponent(t.id)}/delete`, { method: 'POST' });
    toast('템플릿을 지웠습니다.');
    loadTemplates();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('save-template').addEventListener('click', async () => {
  if (!state.pdfBase64) return toast('PDF 파일을 먼저 올려 주세요.', 'error');
  if (state.mode === 'group' && !state.fields.some((f) => f.type === 'signature')) return toast('문서 위에 "✍ 서명" 칸을 1개 이상 놓아 주세요.', 'error');
  const name = window.prompt('템플릿 이름 (다음에 이 이름으로 불러옵니다)', $('title').value.trim() || state.fileName.replace(/\.pdf$/i, ''));
  if (name === null) return undefined;
  const btn = $('save-template');
  btn.disabled = true;
  try {
    await api('/api/templates', {
      method: 'POST',
      body: {
        name,
        mode: state.mode,
        fileName: state.fileName,
        pdfBase64: state.pdfBase64,
        signerCount: state.mode === 'multi' ? state.signers.length : 1,
        info: state.mode === 'group' ? $('info').value.trim() : '',
        requireVerification: $('require-verification').checked,
        fields: state.mode === 'group' ? state.fields.map(({ signerIndex, ...f }) => f) : state.fields,
      },
    });
    toast(`템플릿 "${name.trim()}"을(를) 저장했습니다. 다음부터 이 화면 위쪽에서 불러올 수 있습니다.`);
    loadTemplates();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
  return undefined;
});

// ───── 2-A) 교육생 명단 ─────
const phoneOk = (p) => String(p || '').replace(/\D/g, '').length >= 9;
function renderMembersPreview() {
  state.members = parseMemberList($('members').value);
  const preview = $('members-preview');
  if (state.members.length === 0) {
    preview.textContent = '';
    return;
  }
  const names = state.members.map((m) => m.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const noPhone = state.members.filter((m) => !phoneOk(m.phone)).map((m) => m.name);
  const noEmail = state.members.filter((m) => !m.email).map((m) => m.name);
  const verify = $('require-verification').checked;
  const list = (arr) => `${arr.slice(0, 5).join(', ')}${arr.length > 5 ? ` 외 ${arr.length - 5}명` : ''}`;
  preview.replaceChildren(...[
    h('b', { style: { color: state.members.length > MAX_MEMBERS ? 'var(--danger)' : 'var(--text)' } }, `${state.members.length}명`),
    ` 인식: ${state.members.slice(0, 3).map((m) => [m.name, m.phone, m.email].filter(Boolean).join(' / ')).join(', ')}${state.members.length > 3 ? ' …' : ''}`,
    verify && noPhone.length ? h('div', { style: { color: 'var(--danger)' } }, `✖ 전화번호 없음 ${noPhone.length}명: ${list(noPhone)} — 본인 확인에 필요합니다`) : null,
    noEmail.length ? h('div', { style: { color: 'var(--warn)' } }, `⚠ 이메일 없음 ${noEmail.length}명: ${list(noEmail)} — 이 사람들은 QR·링크·현장 서명으로 받으세요`) : null,
    dupes.length ? h('div', { style: { color: 'var(--warn)' } }, `⚠ 같은 이름이 있습니다: ${dupes.join(', ')} (전화번호로 구분됩니다)`) : null,
  ].filter(Boolean));
}
$('members').addEventListener('input', renderMembersPreview);
$('require-verification').addEventListener('change', renderMembersPreview);

// ───── 2-B) 서명자 (한 문서에 여러 명) ─────
function renderSigners() {
  $('signers').replaceChildren(...state.signers.map((s, i) => h('div', { class: 'signer-row' },
    h('span', { class: 'dot', style: { background: COLORS[i % COLORS.length] } }),
    h('div', { class: 'grow' },
      h('input', {
        type: 'text', value: s.name, placeholder: `서명자 ${i + 1} 이름`, maxlength: 50,
        oninput: (e) => { s.name = e.target.value; renderAll(); },
      }),
      h('input', {
        type: 'email', value: s.email, placeholder: '이메일 (선택)', maxlength: 100, style: { marginTop: '6px' },
        oninput: (e) => { s.email = e.target.value; },
      })),
    state.signers.length > 1
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text', title: '서명자 삭제', onclick: () => removeSigner(i) }, '삭제')
      : null)));
  $('add-signer').disabled = state.signers.length >= MAX_SIGNERS;
}

$('add-signer').addEventListener('click', () => {
  if (state.signers.length >= MAX_SIGNERS) return;
  state.signers.push({ name: '', email: '' });
  state.activeSigner = state.signers.length - 1;
  renderSigners();
  renderAll();
  $('signers').lastElementChild.querySelector('input').focus();
});

function removeSigner(i) {
  state.signers.splice(i, 1);
  state.fields = state.fields
    .filter((f) => f.signerIndex !== i)
    .map((f) => ({ ...f, signerIndex: f.signerIndex > i ? f.signerIndex - 1 : f.signerIndex }));
  state.activeSigner = Math.min(state.activeSigner, state.signers.length - 1);
  renderSigners();
  renderAll();
}

function renderChips() {
  $('types').replaceChildren(...Object.entries(FIELD_TYPES).map(([type, t]) => {
    const count = state.fields.filter((f) => f.type === type && (state.mode === 'group' || f.signerIndex === state.activeSigner)).length;
    return h('button', {
      type: 'button',
      class: `chip${type === state.activeType ? ' active' : ''}`,
      style: { color: type === state.activeType ? t.color : '' },
      onclick: () => { state.activeType = type; renderChips(); },
    }, h('span', { class: 'dot', style: { background: t.color } }), h('span', { style: { color: 'var(--text)' } }, `${t.label} · ${count}`));
  }));
  $('chips').replaceChildren(...state.signers.map((_, i) => {
    const color = COLORS[i % COLORS.length];
    const count = state.fields.filter((f) => f.signerIndex === i).length;
    return h('button', {
      type: 'button',
      class: `chip${i === state.activeSigner ? ' active' : ''}`,
      style: { color: i === state.activeSigner ? color : '' },
      onclick: () => { state.activeSigner = i; renderChips(); },
    }, h('span', { class: 'dot', style: { background: color } }), h('span', { style: { color: 'var(--text)' } }, `${nameOf(i)} · ${count}개`));
  }));
}

// ───── 3) 서명란 배치 ─────
function setupPage(page) {
  page.overlay.classList.add('placing');
  page.overlay.addEventListener('pointerdown', (e) => {
    if (e.target !== page.overlay) return; // 기존 상자를 누른 경우 제외
    const rect = page.overlay.getBoundingClientRect();
    const t = FIELD_TYPES[state.activeType];
    const w = t.w;
    const hgt = (w * page.aspect) / t.ratio;
    const x = clamp((e.clientX - rect.left) / rect.width - w / 2, 0, 1 - w);
    const y = clamp((e.clientY - rect.top) / rect.height - hgt / 2, 0, 1 - hgt);
    const field = { type: state.activeType, signerIndex: state.mode === 'group' ? 0 : state.activeSigner, page: page.number, x, y, w, h: hgt };
    if (isInputType(field.type)) {
      const n = state.fields.filter((f) => f.type === field.type).length + 1;
      Object.assign(field, { label: `${DEFAULT_LABEL[field.type]} ${n}`, required: true });
    }
    state.fields.push(field);
    renderAll();
    if (isInputType(field.type)) {
      // 방금 놓은 칸의 항목 이름을 바로 고칠 수 있게
      const input = $('inputs').querySelector(`[data-index="${state.fields.indexOf(field)}"] input[type=text]`);
      input?.focus({ preventScroll: true }); // 문서가 움직이면 다음 클릭 위치가 어긋나므로 스크롤하지 않음
      input?.select();
    }
  });
}

/** 체크·입력 칸 목록: 항목 이름과 필수 여부 */
function renderInputs() {
  const items = state.fields
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => isInputType(f.type));
  $('inputs-card').hidden = items.length === 0;
  $('inputs').replaceChildren(...items.map(({ f, index }) => h('div', { class: 'input-row', 'data-index': index },
    h('span', { class: 'dot', style: { background: colorOf(f) }, title: FIELD_TYPES[f.type].short }),
    h('span', { class: 'small muted', style: { minWidth: '30px' } }, FIELD_TYPES[f.type].short),
    h('input', {
      type: 'text',
      value: f.label,
      maxlength: 60,
      placeholder: DEFAULT_LABEL[f.type],
      'aria-label': '항목 이름',
      oninput: (e) => {
        f.label = e.target.value;
        if (f.type === 'text') renderBoxes();
      },
    }),
    h('label', { class: 'small', style: { display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' } },
      h('input', { type: 'checkbox', checked: f.required, onchange: (e) => { f.required = e.target.checked; } }), '필수'),
    state.mode === 'multi' ? h('span', { class: 'small muted' }, nameOf(f.signerIndex)) : null,
    h('span', { class: 'small muted' }, `${f.page}쪽`))));
}

function renderAll() {
  renderChips();
  renderBoxes();
  renderInputs();
}

function renderBoxes() {
  for (const page of state.pages) page.overlay.replaceChildren();
  state.fields.forEach((f) => {
    const page = state.pages[f.page - 1];
    if (!page) return;
    const color = colorOf(f);
    const box = h('div', {
      class: `sig-box editable${f.type !== 'signature' ? ' auto' : ''}${f.type === 'checkbox' ? ' tiny' : ''}`,
      style: { borderColor: color, color, background: hexToRgba(color, 0.12) },
      title: isInputType(f.type) ? `${f.label}${f.required ? ' (필수)' : ' (선택)'}` : '',
    },
    h('span', { class: 'label' }, labelOf(f)),
    h('button', {
      type: 'button', class: 'del', title: '칸 삭제', 'aria-label': '칸 삭제',
      onpointerdown: (e) => e.stopPropagation(),
      onclick: () => { state.fields.splice(state.fields.indexOf(f), 1); renderAll(); },
    }, '×'),
    h('span', { class: 'resize' }));
    placeBox(box, f);
    enableDrag(box, f, page.overlay);
    page.overlay.append(box);
  });
}

function enableDrag(box, f, overlay) {
  box.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('del')) return;
    e.preventDefault();
    const resizing = e.target.classList.contains('resize');
    const rect = overlay.getBoundingClientRect();
    const start = { cx: e.clientX, cy: e.clientY, ...f };
    box.setPointerCapture(e.pointerId);
    box.classList.add('selected');

    const move = (ev) => {
      const dx = (ev.clientX - start.cx) / rect.width;
      const dy = (ev.clientY - start.cy) / rect.height;
      if (resizing) {
        f.w = clamp(start.w + dx, 0.04, 1 - f.x);
        f.h = clamp(start.h + dy, 0.015, 1 - f.y);
      } else {
        f.x = clamp(start.x + dx, 0, 1 - f.w);
        f.y = clamp(start.y + dy, 0, 1 - f.h);
      }
      placeBox(box, f);
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      box.classList.remove('selected');
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });
}

// ───── 4) 만들기 ─────
function validate() {
  if (!state.pdfBase64) return 'PDF 파일을 먼저 올려 주세요.';
  if (!$('title').value.trim()) { $('title').focus(); return state.mode === 'group' ? '교육명을 입력해 주세요.' : '문서 제목을 입력해 주세요.'; }
  if (state.mode === 'group') {
    if (state.members.length === 0) { $('members').focus(); return '교육생 명단을 입력해 주세요.'; }
    if (state.members.length > MAX_MEMBERS) return `한 번에 ${MAX_MEMBERS}명까지 등록할 수 있습니다. 나머지는 만든 뒤 "교육생 추가"로 넣어 주세요.`;
    const noPhone = state.members.find((m) => !phoneOk(m.phone));
    if ($('require-verification').checked && noPhone) return `${noPhone.name} 님의 전화번호가 없습니다. 본인 확인에 필요해요. (본인 확인을 끄면 없어도 됩니다)`;
    if (!state.fields.some((f) => f.type === 'signature')) return '문서 위에 "✍ 서명" 칸을 1개 이상 놓아 주세요.';
    return null;
  }
  const blank = state.signers.findIndex((s) => !s.name.trim());
  if (blank >= 0) return `${blank + 1}번 서명자의 이름을 입력해 주세요.`;
  const noField = state.signers.findIndex((_, i) => !state.fields.some((f) => f.signerIndex === i && f.type === 'signature'));
  if (noField >= 0) {
    state.activeSigner = noField;
    renderChips();
    return `${nameOf(noField)} 님의 "✍ 서명" 칸을 문서 위에 놓아 주세요.`;
  }
  return null;
}

$('submit').addEventListener('click', async () => {
  const problem = validate();
  if (problem) return toast(problem, 'error');

  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  const common = { title: $('title').value.trim(), fileName: state.fileName, pdfBase64: state.pdfBase64 };
  try {
    if (state.mode === 'group') {
      const group = await api('/api/groups', {
        method: 'POST',
        body: {
          ...common,
          info: $('info').value.trim(),
          requireVerification: $('require-verification').checked,
          members: state.members,
          fields: state.fields.map(({ signerIndex, ...f }) => f),
        },
      });
      location.href = `/group.html?id=${encodeURIComponent(group.id)}&created=1`;
    } else {
      const doc = await api('/api/documents', {
        method: 'POST',
        body: {
          ...common,
          signers: state.signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })),
          fields: state.fields,
        },
      });
      location.href = `/doc.html?id=${encodeURIComponent(doc.id)}&created=1`;
    }
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '서명 요청 만들기';
  }
  return undefined;
});

setMode('group');
loadTemplates();
