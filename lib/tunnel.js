'use strict';
// 집에서도 서명할 수 있도록 Cloudflare 임시 터널(https://xxxx.trycloudflare.com)로 이 PC의 서버를 인터넷에 공개한다.
//  - 계정·도메인 없이 cloudflared 프로그램만 있으면 된다.
//  - 주소는 터널을 켤 때마다 바뀐다 → 서버를 다시 켜면 이미 보낸 메일 링크는 열리지 않는다.
//  - cloudflared가 끊기면 자동으로 다시 켠다 (이때도 주소가 바뀐다).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** cloudflared 출력 한 줄에서 공개 주소를 찾는다 */
const parseTunnelUrl = (line) => (URL_RE.exec(String(line)) || [])[0] || null;

/** cloudflared 실행 파일 위치: ESIGN_CLOUDFLARED > PATH > 기본 설치 위치 */
function findCloudflared(env = process.env) {
  if (env.ESIGN_CLOUDFLARED) return fs.existsSync(env.ESIGN_CLOUDFLARED) ? env.ESIGN_CLOUDFLARED : null;
  const names = process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    dirs.push(
      'C:\\Program Files (x86)\\cloudflared',
      'C:\\Program Files\\cloudflared',
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
    );
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  }
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 터널을 켠다.
 * @param {object} p
 * @param {number} p.port 이 PC에서 서버가 듣는 포트
 * @param {string[]} [p.command] 실행할 명령 (테스트용). 기본은 cloudflared quick tunnel
 * @param {(url: string) => void} [p.onUrl] 새 공개 주소가 생길 때마다
 * @param {Console} [p.log]
 * @returns {{ state: () => {status: string, url: string|null, error: string|null}, stop: () => void }}
 */
function startTunnel({ port, command, onUrl, log = console, restartDelayMs = 5000 }) {
  const state = { status: 'starting', url: null, error: null, restarts: 0 };
  let child = null;
  let stopped = false;
  let timer = null;

  const exe = command ? command[0] : findCloudflared();
  if (!exe) {
    state.status = 'missing';
    state.error = 'cloudflared 프로그램이 없습니다.';
    return { state: () => ({ status: state.status, url: null, error: state.error }), stop() {} };
  }
  const args = command ? command.slice(1) : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];

  function launch() {
    state.status = 'starting';
    state.url = null;
    child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buffered = '';
    const onData = (chunk) => {
      buffered = (buffered + chunk.toString()).slice(-4000);
      const url = parseTunnelUrl(buffered);
      if (url && url !== state.url) {
        state.url = url;
        state.status = 'up';
        state.error = null;
        onUrl?.(url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      state.status = 'down';
      state.error = `cloudflared를 실행할 수 없습니다: ${err.message}`;
    });
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      state.status = 'down';
      state.url = null;
      state.error ||= `cloudflared가 종료되었습니다 (코드 ${code}).`;
      state.restarts += 1;
      const delay = Math.min(restartDelayMs * state.restarts, 60_000);
      log.warn(`⚠ 인터넷 공개 주소(터널)가 끊겼습니다. ${Math.round(delay / 1000)}초 뒤 다시 연결합니다. 주소가 바뀌니 미서명자에게 다시 알림을 보내세요.`);
      timer = setTimeout(() => {
        state.error = null;
        launch();
      }, delay);
    });
  }

  launch();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (child) child.kill();
  };
  process.once('exit', stop);
  return { state: () => ({ status: state.status, url: state.url, error: state.error }), stop };
}

module.exports = { startTunnel, findCloudflared, parseTunnelUrl };
