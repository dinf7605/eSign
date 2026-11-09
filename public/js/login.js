import { api, h, toast } from './common.js';

const box = document.getElementById('box');
const nextParam = new URLSearchParams(location.search).get('next') || '/';
// 같은 사이트 안의 경로로만 이동 (외부 주소로 보내는 것 방지)
const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

function form({ title, desc, confirm, button, onSubmit }) {
  const pw = h('input', { type: 'password', autocomplete: confirm ? 'new-password' : 'current-password', required: true, minlength: confirm ? 8 : null });
  const pw2 = confirm ? h('input', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-lg', style: { width: '100%' } }, button);
  const el = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (confirm && pw.value !== pw2.value) return toast('두 비밀번호가 다릅니다.', 'error');
      btn.disabled = true;
      try {
        await onSubmit(pw.value);
        location.href = next;
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        pw.select();
      }
      return undefined;
    },
  },
  h('h1', {}, title),
  h('p', { class: 'sub' }, desc),
  h('label', { class: 'field' }, h('span', {}, confirm ? '새 비밀번호 (8자 이상)' : '비밀번호'), pw),
  confirm ? h('label', { class: 'field' }, h('span', {}, '비밀번호 확인'), pw2) : null,
  btn);
  box.replaceChildren(el);
  pw.focus();
}

const status = await api('/api/auth/status');
if (status.loggedIn) {
  location.href = next;
} else if (status.setupRequired && status.canSetup) {
  form({
    title: '관리자 비밀번호 만들기',
    desc: '처음 한 번만 설정합니다. 문서함·서명부는 이 비밀번호로만 볼 수 있어요.',
    confirm: true,
    button: '설정하고 시작하기',
    onSubmit: (password) => api('/api/auth/setup', { method: 'POST', body: { password } }),
  });
} else if (status.setupRequired) {
  box.replaceChildren(h('div', { class: 'center-msg' }, h('div', { class: 'icon' }, '🔒'),
    h('h2', {}, '아직 관리자 비밀번호가 없습니다'),
    h('p', { class: 'muted' }, '서버를 실행한 PC에서 http://localhost:3300 으로 접속해 먼저 비밀번호를 설정해 주세요.')));
} else {
  form({
    title: '담당자 로그인',
    desc: '관리자 비밀번호를 입력해 주세요.',
    button: '로그인',
    onSubmit: (password) => api('/api/auth/login', { method: 'POST', body: { password } }),
  });
}
