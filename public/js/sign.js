import { api, h, fmtDate, toast, placeBox, fmtDeadline, localPath } from './common.js';
import { renderPdf } from './pdfview.js';
import { SignaturePad } from './signature-pad.js';

const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
// "이 기기에서 서명받기"로 들어온 경우 돌아갈 화면 (같은 사이트 안 경로만 허용)
const returnTo = localPath(params.get('return'));
const base = `/api/sign/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

const signatures = {}; // fieldId → PNG data URL
const values = {}; // fieldId → true/false (체크) 또는 글자 (입력란)
let view;
let pages = [];
const boxes = new Map(); // fieldId → 상자 요소
let editingField = null;

const sigFields = () => view.fields.filter((f) => f.type === 'signature');
const inputFields = () => view.fields.filter((f) => f.type === 'checkbox' || f.type === 'text');
/** 아직 채워야 하는 칸: 서명 안 한 서명란 + 체크 안 한 필수 체크 + 비어 있는 필수 입력란 */
const missingFields = () => view.fields.filter((f) => (f.type === 'signature' && !signatures[f.id])
  || (f.required && f.type === 'checkbox' && values[f.id] !== true)
  || (f.required && f.type === 'text' && !String(values[f.id] || '').trim()));
const todayText = () => new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });

const pad = new SignaturePad($('pad'), { onChange: () => updatePadButtons() });

function updatePadButtons() {
  $('pad-apply').disabled = pad.isEmpty();
  $('pad-hint').hidden = !pad.isEmpty();
}

function backButton() {
  return returnTo ? h('a', { class: 'btn btn-lg', href: returnTo, style: { marginTop: '10px' } }, '← 서명 현황으로 돌아가기') : null;
}

async function init() {
  try {
    view = await api(base);
  } catch (err) {
    $('intro').replaceChildren(h('div', { class: 'card center-msg' }, h('div', { class: 'icon' }, '🔒'), err.message, h('div', {}, backButton())));
    return;
  }
  $('doc-title').textContent = view.documentTitle;
  document.title = `${view.documentTitle} · 서명`;
  if (view.verificationRequired) showVerify();
  else proceed();
}

/** 본인 확인: 담당자가 등록한 이름 + 전화번호와 일치해야 문서를 볼 수 있다 */
function showVerify() {
  const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 50, placeholder: '홍길동' });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', required: true, maxlength: 30, placeholder: '010-1234-5678' });
  const error = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-lg', style: { width: '100%' } }, '확인');
  const form = h('form', {
    class: 'card verify-card',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      error.textContent = '';
      try {
        view = await api(`${base}/verify`, { method: 'POST', body: { name: name.value, phone: phone.value } });
        proceed();
      } catch (err) {
        error.textContent = err.message;
        btn.disabled = false;
      }
    },
  },
  h('div', { class: 'icon', style: { fontSize: '38px', textAlign: 'center' } }, '🔐'),
  h('h1', { style: { textAlign: 'center' } }, '본인 확인'),
  h('p', { class: 'sub', style: { textAlign: 'center' } }, h('b', {}, view.documentTitle), h('br'), '서명하려면 담당자에게 알려 준 이름과 전화번호를 입력해 주세요.'),
  h('label', { class: 'field' }, h('span', {}, '이름'), name),
  h('label', { class: 'field' }, h('span', {}, '전화번호'), phone),
  error,
  btn,
  h('p', { class: 'small muted', style: { margin: '12px 0 0', textAlign: 'center' } }, '정보가 맞지 않으면 담당자에게 문의해 주세요.'));
  $('intro').replaceChildren(form);
  name.focus();
}

async function proceed() {
  if (view.signer.status === 'signed' || view.documentStatus !== 'pending') {
    showDone();
    return;
  }

  const count = sigFields().length;
  $('intro').replaceChildren(h('div', { class: 'card' },
    h('h1', {}, view.documentTitle),
    h('p', { class: 'sub', style: { margin: 0 } },
      h('b', {}, view.signer.name), ' 님, 문서 내용을 끝까지 확인하고 ',
      h('b', { style: { color: '#b35c00' } }, `노란색 서명란${count > 1 ? ` ${count}곳` : ''}`), '을 눌러 서명해 주세요.'),
    view.fields.some((f) => f.type === 'name' || f.type === 'date')
      ? h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, '초록색 칸(이름·날짜)은 제출할 때 자동으로 채워집니다.')
      : null,
    inputFields().length
      ? h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, '네모 칸은 눌러서 체크하고, 입력란에는 내용을 적어 주세요. 주황색 테두리는 필수 항목입니다.')
      : null,
    view.deadline
      ? h('p', { class: 'small', style: { margin: '6px 0 0', color: '#b35c00', fontWeight: 700 } }, `⏰ 서명 기한: ${fmtDeadline(view.deadline)}까지`)
      : null));

  $('consent-text').textContent = view.consentText;
  $('bar').hidden = false;
  updateProgress();

  try {
    ({ pages } = await renderPdf($('pages'), `${base}/document.pdf`));
  } catch (err) {
    console.error(err);
    toast('문서를 불러오지 못했습니다.', 'error');
    return;
  }
  for (const f of view.fields) {
    let box;
    if (f.type === 'signature') {
      box = h('div', {
        class: 'sig-box to-sign', role: 'button', tabindex: 0, title: '눌러서 서명',
        onclick: () => openPad(f),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPad(f); } },
      }, h('span', { class: 'label' }, '여기를 눌러 서명'));
    } else if (f.type === 'checkbox') {
      values[f.id] = f.value === true;
      const toggle = () => {
        values[f.id] = !values[f.id];
        renderCheck(f);
        updateProgress();
      };
      box = h('div', {
        class: `sig-box input-check${f.required ? ' need' : ''}`, role: 'checkbox', tabindex: 0,
        title: `${f.label}${f.required ? ' (필수)' : ' (선택)'}`, 'aria-label': `${f.label}${f.required ? ' (필수)' : ' (선택)'}`,
        onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
      }, h('span', { class: 'mark' }), h('span', { class: 'cap' }, `${f.label}${f.required ? ' *' : ''}`));
    } else if (f.type === 'text') {
      values[f.id] = f.value || '';
      box = h('div', { class: `sig-box input-text${f.required ? ' need' : ''}`, title: `${f.label}${f.required ? ' (필수)' : ' (선택)'}` },
        h('input', {
          type: 'text', maxlength: 200, value: values[f.id], placeholder: f.label,
          'aria-label': `${f.label}${f.required ? ' (필수)' : ' (선택)'}`,
          oninput: (e) => {
            values[f.id] = e.target.value;
            box.classList.toggle('done', Boolean(e.target.value.trim()));
            updateProgress();
          },
        }));
    } else {
      box = h('div', { class: 'sig-box auto-fill', title: '제출할 때 자동 입력' },
        h('span', { class: 'label' }, f.type === 'name' ? view.signer.name : todayText()));
    }
    placeBox(box, f);
    pages[f.page - 1]?.overlay.append(box);
    boxes.set(f.id, box);
    if (f.type === 'checkbox') renderCheck(f);
  }
  updateProgress();
}

function renderCheck(f) {
  const box = boxes.get(f.id);
  if (!box) return;
  const on = values[f.id] === true;
  box.classList.toggle('done', on);
  box.setAttribute('aria-checked', String(on));
  box.querySelector('.mark').textContent = on ? '✓' : '';
}

// 서명란의 실제 가로/세로 비율 = (서명란 비율) × (페이지 가로/세로 비율)
const aspectOf = (f) => (f.w / f.h) * (pages[f.page - 1]?.aspect || 1);

function openPad(field) {
  editingField = field;
  const unsigned = sigFields().filter((f) => !signatures[f.id]).length;
  $('apply-all-wrap').hidden = sigFields().length < 2 || unsigned < 2;
  $('pad-dialog').showModal();
  pad.resize(); // showModal 직후 크기를 재면 레이아웃이 이미 잡혀 있음
  pad.clear();
}

$('pad-clear').addEventListener('click', () => pad.clear());
$('pad-undo').addEventListener('click', () => pad.undo());
$('pad-cancel').addEventListener('click', () => $('pad-dialog').close());
$('pad-apply').addEventListener('click', () => {
  if (pad.isEmpty() || !editingField) return;
  const applyAll = !$('apply-all-wrap').hidden && $('apply-all').checked;
  const targets = applyAll ? sigFields().filter((f) => f === editingField || !signatures[f.id]) : [editingField];
  for (const f of targets) {
    signatures[f.id] = pad.toPng(aspectOf(f));
    const box = boxes.get(f.id);
    box.classList.add('done');
    box.replaceChildren(h('img', { src: signatures[f.id], alt: '내 서명' }));
  }
  $('pad-dialog').close();
  updateProgress();
  if (sigFields().every((f) => signatures[f.id]) && !$('consent').checked) {
    $('bar').scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
});

function updateProgress() {
  if (!view) return;
  const sig = sigFields();
  const signed = sig.filter((f) => signatures[f.id]).length;
  const missing = missingFields();
  const missingInputs = missing.filter((f) => f.type !== 'signature').length;
  let text;
  if (signed !== sig.length) text = `서명란 ${signed} / ${sig.length} 완료${missingInputs ? ` · 필수 항목 ${missingInputs}개 남음` : ''}`;
  else if (missingInputs) text = `필수 항목 ${missingInputs}개를 체크·입력해 주세요`;
  else text = $('consent').checked ? '준비 완료 ✓ 제출 버튼을 눌러 주세요' : '서명 완료 ✓ 아래 동의에 체크해 주세요';
  $('progress').textContent = text;
  $('next').hidden = missing.length === 0;
  $('next').textContent = signed !== sig.length ? '다음 서명란으로 ↓' : '남은 항목으로 ↓';
  $('submit').disabled = missing.length > 0 || !$('consent').checked;
}
$('consent').addEventListener('change', updateProgress);

$('next').addEventListener('click', () => {
  const next = missingFields()[0];
  if (!next) return;
  const box = boxes.get(next.id);
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (next.type !== 'signature') toast(`필수 항목: ${next.label}`);
  if (next.type === 'text') setTimeout(() => box?.querySelector('input')?.focus({ preventScroll: true }), 400);
});

$('submit').addEventListener('click', async () => {
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = '제출 중…';
  try {
    const answers = Object.fromEntries(inputFields().map((f) => [f.id, f.type === 'checkbox' ? values[f.id] === true : String(values[f.id] || '')]));
    view = await api(base, { method: 'POST', body: { consent: $('consent').checked, signatures, values: answers } });
    showDone();
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = '서명 제출';
    updateProgress();
  }
});

function showDone() {
  $('bar').hidden = true;
  $('pages').replaceChildren();
  const completed = view.documentStatus === 'completed';
  $('intro').replaceChildren(h('div', { class: 'card center-msg' },
    h('div', { class: 'icon' }, completed ? '✅' : '✍️'),
    h('h1', {}, completed ? '서명이 완료되었습니다' : '서명을 제출했습니다'),
    h('p', { class: 'muted' }, view.signer.signedAt ? `${view.signer.name} 님 · ${fmtDate(view.signer.signedAt)} 서명` : ''),
    completed
      ? h('a', { class: 'btn btn-primary btn-lg', href: `${base}/completed.pdf` }, '⬇ 서명한 문서 받기')
      : h('p', { class: 'muted' }, '다른 서명자의 서명이 모두 끝나면 이 링크에서 최종 문서를 받을 수 있습니다.'),
    h('div', {}, backButton())));
}

init();
