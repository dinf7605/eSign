// 새 서명 요청 화면의 교육생 명단 입력 창: 이름·소속·전화번호·이메일을 칸마다 나눠 입력, 엑셀 붙여넣기, CSV 불러오기
import { h, toast } from './common.js';
import { ROSTER_COLUMNS, parseCsv, headerMap, rowsToMembers, decodeCsvBytes, memberProblems, rosterCsvTemplate, fixPhone } from './roster.js';

const COLS = [
  { key: 'name', label: '이름', max: 50, placeholder: '김교육', type: 'text' },
  { key: 'org', label: '소속', max: 50, placeholder: '1반 (선택)', type: 'text' },
  { key: 'phone', label: '전화번호', max: 30, placeholder: '010-1234-5678', type: 'tel' },
  { key: 'email', label: '이메일', max: 100, placeholder: 'kim@example.com', type: 'email' },
];
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const blankRow = () => ({ name: '', org: '', phone: '', email: '', touched: false });
const isBlank = (r) => !ROSTER_COLUMNS.some((c) => String(r[c] || '').trim());

/**
 * @param {object} o
 * @param {() => boolean} o.requirePhone 본인 확인을 켰는지 (전화번호 필수)
 * @param {() => void} o.onChange 명단이 바뀔 때마다
 * @param {string} [o.title] 창 제목
 * @param {string} [o.submitLabel] 아래 버튼 이름
 * @param {(members: object[]) => Promise<boolean>} [o.onSubmit] 있으면 아래 버튼이 명단을 넘기고, true를 돌려주면 비우고 닫는다
 */
export function createRosterEditor({ requirePhone = () => false, onChange = () => {}, title = '교육생 명단', submitLabel = '완료', onSubmit = null } = {}) {
  let rows = [blankRow()];

  const tbody = h('tbody');
  const countEl = h('span', { class: 'roster-count small muted' });
  const problemEl = h('span', { class: 'roster-problem small' });
  const phoneTh = h('th', { 'data-col': 'phone' }, '전화번호');
  const fileInput = h('input', {
    type: 'file', accept: '.csv,text/csv', hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await importFile(file);
    },
  });
  const dialog = h('dialog', { class: 'roster-dialog' },
    h('div', { class: 'dialog-body' },
      h('h2', { style: { margin: '0 0 4px' } }, title),
      h('p', { class: 'small muted', style: { margin: '0 0 12px' } },
        '칸마다 나눠 입력하세요. 엑셀에서 여러 칸을 복사해 ', h('b', {}, '이름 칸에 붙여넣거나'), ' CSV 파일을 불러올 수도 있습니다. Enter를 누르면 아래 줄로 갑니다.'),
      h('div', { class: 'roster-toolbar' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => fileInput.click() }, '📂 CSV 불러오기'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: downloadTemplate }, 'CSV 양식 받기'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger-text', onclick: clearAll }, '모두 지우기'),
        countEl, fileInput),
      h('div', { class: 'roster-wrap' },
        h('table', { class: 'roster-table' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'roster-no' }, '번호'),
            h('th', { 'data-col': 'name' }, '이름 *'),
            h('th', { 'data-col': 'org' }, '소속'),
            phoneTh,
            h('th', { 'data-col': 'email' }, '이메일'),
            h('th', { class: 'roster-del' }, ''))),
          tbody)),
      h('button', { type: 'button', class: 'btn btn-sm', style: { marginTop: '10px' }, onclick: () => { addRow(); focusCell(rows.length - 1, 0); } }, '+ 한 줄 추가')),
    h('div', { class: 'dialog-foot roster-foot' },
      problemEl,
      onSubmit ? h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, '닫기') : null,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: submit }, submitLabel)));
  const submitBtn = dialog.querySelector('.roster-foot .btn-primary');
  document.body.append(dialog);

  async function submit() {
    if (!onSubmit) return dialog.close();
    const list = members();
    if (!list.length) { focusCell(0, 0); return toast('추가할 교육생을 입력해 주세요.', 'error'); }
    const bad = listProblems()[0];
    if (bad) {
      showProblems();
      return toast(`${bad.name ? `${bad.name} 님(${bad.row}번째 줄)` : `${bad.row}번째 줄`}: ${bad.message}`, 'error');
    }
    submitBtn.disabled = true;
    try {
      if (await onSubmit(list)) {
        rows = [];
        render();
        dialog.close();
      }
    } finally {
      submitBtn.disabled = false;
    }
    return undefined;
  }

  // ── 화면 그리기 ──
  function rowEl(r, i) {
    const tr = h('tr');
    tr.append(h('td', { class: 'roster-no' }, String(i + 1)));
    COLS.forEach((c, ci) => {
      const input = h('input', {
        type: c.type, maxlength: c.max, autocomplete: 'off',
        placeholder: i === 0 ? c.placeholder : '',
        'aria-label': `${i + 1}번째 ${c.label}`,
        inputmode: c.type === 'tel' ? 'tel' : null,
      });
      input.value = r[c.key] || '';
      input.addEventListener('input', () => { rows[i][c.key] = input.value; afterEdit(i); });
      input.addEventListener('paste', (e) => onPaste(e, i, ci));
      input.addEventListener('keydown', (e) => onKey(e, i, ci));
      if (c.key === 'phone') {
        input.addEventListener('change', () => {
          const fixed = fixPhone(input.value);
          if (fixed !== input.value) { input.value = fixed; rows[i].phone = fixed; afterEdit(i); }
        });
      }
      tr.append(h('td', {}, input));
    });
    tr.append(h('td', { class: 'roster-del' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: '이 줄 지우기', 'aria-label': `${i + 1}번째 줄 지우기`, onclick: () => removeRow(i) }, '✕')));
    // 줄을 떠날 때부터 빨간 칸으로 알려 준다 (입력 도중에는 조용히)
    tr.addEventListener('focusout', (e) => {
      if (tr.contains(e.relatedTarget)) return;
      if (!isBlank(rows[i])) { rows[i].touched = true; markRow(i); updateStatus(); }
    });
    return tr;
  }

  function render() {
    if (!rows.length || !isBlank(rows[rows.length - 1])) rows.push(blankRow());
    phoneTh.textContent = requirePhone() ? '전화번호 *' : '전화번호';
    tbody.replaceChildren(...rows.map(rowEl));
    rows.forEach((_, i) => markRow(i));
    updateStatus();
  }

  function markRow(i) {
    const tr = tbody.children[i];
    if (!tr) return;
    const problems = rows[i].touched ? memberProblems(rows[i], { requirePhone: requirePhone() }) : {};
    tr.querySelectorAll('input').forEach((input, ci) => {
      const msg = problems[COLS[ci].key];
      input.classList.toggle('invalid', Boolean(msg));
      if (msg) input.title = msg; else input.removeAttribute('title');
    });
  }

  function updateStatus() {
    const n = members().length;
    countEl.textContent = n ? `${n}명` : '';
    const bad = listProblems().filter((p) => rows[p.row - 1].touched).length; // 빨간 칸과 같은 기준 (입력 중인 줄은 빼고)
    problemEl.textContent = bad ? `✖ 빨간 칸을 확인해 주세요 (${bad}줄)` : '';
  }

  // ── 편집 ──
  function afterEdit(i) {
    if (i === rows.length - 1 && !isBlank(rows[i])) {
      rows.push(blankRow());
      tbody.append(rowEl(rows[rows.length - 1], rows.length - 1));
    }
    markRow(i);
    updateStatus();
    onChange();
  }

  function addRow() {
    rows.push(blankRow());
    tbody.append(rowEl(rows[rows.length - 1], rows.length - 1));
  }

  function removeRow(i) {
    rows.splice(i, 1);
    render();
    onChange();
  }

  function focusCell(r, c) {
    if (r >= rows.length) addRow();
    tbody.children[r]?.querySelectorAll('input')[c]?.focus();
  }

  function onKey(e, i, ci) {
    if (e.isComposing) return; // 한글 조합 중 Enter는 글자 확정
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); focusCell(i + 1, ci); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); focusCell(i - 1, ci); }
  }

  // 엑셀에서 여러 칸·여러 줄을 복사해 붙여넣으면 표에 나눠 채운다
  function onPaste(e, i, ci) {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/[\t\n]/.test(text.trim())) return; // 한 칸짜리는 그냥 붙여넣기
    e.preventDefault();
    const grid = parseCsv(text, text.includes('\t') ? '\t' : undefined);
    if (!grid.length) return;
    if (ci === 0 || headerMap(grid[0])) {
      // 이름 칸부터: 열 순서가 달라도 머리글·내용(@, 숫자)으로 칸을 맞춘다
      rowsToMembers(grid).forEach((m, k) => {
        rows[i + k] = { ...blankRow(), ...m, touched: true };
      });
    } else {
      // 다른 칸부터: 붙여넣은 자리에서 오른쪽으로 차례대로
      grid.forEach((cells, k) => {
        const r = rows[i + k] || blankRow();
        cells.forEach((v, j) => {
          const col = COLS[ci + j];
          if (col) r[col.key] = col.key === 'phone' ? fixPhone(v) : v;
        });
        r.touched = true;
        rows[i + k] = r;
      });
    }
    for (let k = 0; k < rows.length; k += 1) rows[k] ||= blankRow();
    render();
    onChange();
    toast(`${grid.length}줄을 붙여넣었습니다.`);
  }

  function clearAll() {
    if (members().length && !window.confirm('입력한 명단을 모두 지울까요?')) return;
    rows = [];
    render();
    onChange();
  }

  // ── CSV ──
  async function importFile(file) {
    if (file.size > MAX_CSV_BYTES) return toast('CSV 파일이 너무 큽니다 (2MB까지).', 'error');
    let grid;
    try {
      grid = parseCsv(decodeCsvBytes(new Uint8Array(await file.arrayBuffer())));
    } catch {
      return toast('CSV 파일을 읽지 못했습니다.', 'error');
    }
    const list = rowsToMembers(grid);
    if (!list.length) return toast('CSV에서 교육생을 찾지 못했습니다. 첫 줄에 이름·소속·전화번호·이메일 머리글을 넣어 주세요.', 'error');
    const existing = members().length;
    if (existing && !window.confirm(`지금 입력된 ${existing}명을 CSV의 ${list.length}명으로 바꿀까요?`)) return;
    rows = list.map((m) => ({ ...blankRow(), ...m, touched: true }));
    render();
    onChange();
    toast(headerMap(grid[0])
      ? `CSV에서 ${list.length}명을 불러왔습니다.`
      : `CSV에서 ${list.length}명을 불러왔습니다. 머리글이 없어 내용으로 칸을 맞췄으니 확인해 주세요.`);
    if (!dialog.open) open();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([rosterCsvTemplate()], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: '교육생_명단_양식.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── 바깥에서 쓰는 것 ──
  function members() {
    return rows.filter((r) => !isBlank(r)).map((r) => Object.fromEntries(ROSTER_COLUMNS.map((c) => [c, String(r[c] || '').trim()])));
  }

  /** 문제가 있는 줄: [{ row: 줄 번호(1부터), message }] */
  function listProblems() {
    const out = [];
    rows.forEach((r, i) => {
      const p = memberProblems(r, { requirePhone: requirePhone() });
      const first = COLS.find((c) => p[c.key]);
      if (first) out.push({ row: i + 1, name: String(r.name || '').trim(), message: p[first.key] });
    });
    return out;
  }

  function open() {
    render();
    if (!dialog.open) dialog.showModal();
    const firstBlank = rows.findIndex(isBlank);
    focusCell(firstBlank < 0 ? rows.length - 1 : firstBlank, 0);
  }

  /** 문제 줄을 모두 빨간 칸으로 보이며 창을 연다 */
  function showProblems() {
    rows.forEach((r) => { if (!isBlank(r)) r.touched = true; });
    render();
    if (!dialog.open) dialog.showModal();
    const first = listProblems()[0];
    if (first) {
      const ci = COLS.findIndex((c) => memberProblems(rows[first.row - 1], { requirePhone: requirePhone() })[c.key]);
      focusCell(first.row - 1, Math.max(ci, 0));
    }
  }

  return {
    open,
    showProblems,
    members,
    problems: listProblems,
    pickFile: () => fileInput.click(),
    downloadTemplate,
    /** 본인 확인 사용 여부가 바뀌었을 때 */
    refresh: () => { if (dialog.open) render(); else updateStatus(); },
  };
}
