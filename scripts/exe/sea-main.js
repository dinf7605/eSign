'use strict';
// 배포용 eSign.exe의 시작 프로그램 (Node 단일 실행 파일, scripts/build-exe.js가 exe 안에 넣는다)
//  - exe 안에 든 앱 파일(server.js·lib·public·node_modules)을 처음 한 번 %LOCALAPPDATA%\eSign\app\<버전>에 풀어 놓는다
//  - 데이터는 exe 옆 data\ 폴더, cloudflared는 exe 옆 cloudflared.exe를 쓴다
//  - 옵션 없이 더블클릭하면 인터넷 공개 모드(집에서 서명)로 켜고 관리자 화면을 연다
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const sea = require('node:sea');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const exeDir = path.dirname(process.execPath);

function stop(message) {
  console.log(`\n${message}`);
  console.log('\n창을 닫으려면 Enter를 누르세요.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    stop('⚠ e서명이 이미 켜져 있습니다 (포트 3300 사용 중).\n   먼저 켜 둔 창을 그대로 쓰거나, 그 창을 닫은 뒤 다시 실행하세요.');
  } else {
    stop(`⚠ 오류로 멈췄습니다:\n${(err && err.stack) || err}`);
  }
});

/** exe 안의 앱 파일을 풀어 놓고 그 폴더를 돌려준다 (같은 버전이면 다시 풀지 않음) */
function unpackApp() {
  const id = sea.getAsset('app-id', 'utf8').trim();
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'eSign', 'app');
  const dir = path.join(base, id);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;

  console.log('처음 실행 준비 중… (몇 초 걸립니다)');
  const blob = zlib.brotliDecompressSync(Buffer.from(sea.getRawAsset('app')));
  const headerLen = blob.readUInt32LE(0);
  const index = JSON.parse(blob.subarray(4, 4 + headerLen).toString('utf8'));
  let offset = 4 + headerLen;
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, size] of index) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob.subarray(offset, offset + size));
    offset += size;
  }
  fs.writeFileSync(path.join(tmp, '.complete'), id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // 예전 버전 정리 (쓰는 중이면 남겨 둠)
  for (const old of fs.readdirSync(base)) {
    if (old !== id) try { fs.rmSync(path.join(base, old), { recursive: true, force: true }); } catch { /* 다음에 */ }
  }
  return dir;
}

/** exe 옆 data 폴더를 쓸 수 있는지 확인 */
function prepareDataDir() {
  const dataDir = process.env.ESIGN_DATA_DIR || path.join(exeDir, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch {
    stop(`⚠ 데이터 폴더에 저장할 수 없습니다: ${dataDir}\n   eSign.exe가 든 폴더를 C:\\e서명 처럼 쓰기 가능한 곳으로 옮긴 뒤 다시 실행하세요.\n   (C:\\Program Files 안에서는 실행할 수 없습니다)`);
    return null;
  }
  return dataDir;
}

function start() {
  console.log('e서명 전자서명 서비스');
  console.log(`데이터 폴더: ${path.join(exeDir, 'data')}`);
  if (/onedrive/i.test(exeDir)) {
    console.log('⚠ OneDrive 폴더 안에서 실행 중입니다. 개인정보·비밀번호가 클라우드로 동기화되니 C:\\e서명 같은 폴더로 옮기는 것을 권장합니다.');
  }
  const dataDir = prepareDataDir();
  if (!dataDir) return;
  process.env.ESIGN_DATA_DIR = dataDir;

  const cloudflared = path.join(exeDir, 'cloudflared.exe');
  if (!process.env.ESIGN_CLOUDFLARED && fs.existsSync(cloudflared)) process.env.ESIGN_CLOUDFLARED = cloudflared;

  // 옵션 없이 실행하면 집에서 서명받는 인터넷 공개 모드. --local(이 PC만)·--lan(같은 Wi-Fi)도 쓸 수 있다.
  const modes = ['--public', '--lan', '--local'];
  if (!process.argv.slice(2).some((a) => modes.includes(a))) process.argv.push('--public');

  const appDir = unpackApp();
  const { main } = createRequire(path.join(appDir, 'server.js'))('./server.js');
  const server = main();
  server.once('listening', () => {
    const url = `http://localhost:${server.address().port}`;
    console.log('\n관리자 화면을 브라우저로 엽니다. 이 창을 닫으면 서비스가 꺼집니다.');
    if (process.env.ESIGN_NO_BROWSER) return; // 자동 점검용
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

start();
