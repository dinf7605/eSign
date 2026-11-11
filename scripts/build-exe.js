'use strict';
// 운영팀 배포용 exe 만들기: npm run build:exe
//  → dist/e서명/ (eSign.exe + cloudflared.exe + 사용법.txt) 와 dist/e서명-배포.zip
// Node 단일 실행 파일(SEA, node --build-sea)을 쓴다. 앱 파일은 압축해 exe 안에 넣고, 실행할 때 한 번 풀어 쓴다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const work = path.join(dist, '.build');
const outDir = path.join(dist, 'e서명');
const zipPath = path.join(dist, 'e서명-배포.zip');
const SKIP_EXT = new Set(['.map', '.ts', '.md', '.markdown']);

function walk(dir, { skipNodeModules = false } = {}, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipNodeModules && ent.name === 'node_modules') continue;
      walk(full, { skipNodeModules }, out);
    } else if (ent.isFile() && !SKIP_EXT.has(path.extname(ent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** 실행에 필요한 파일: 서버 코드·화면·운영용 패키지(개발용 제외) */
function collectFiles() {
  const files = new Set([path.join(root, 'server.js'), path.join(root, 'package.json')]);
  for (const dir of ['lib', 'public']) walk(path.join(root, dir)).forEach((f) => files.add(f));
  const prodDirs = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && path.resolve(s) !== path.resolve(root));
  if (!prodDirs.length) throw new Error('운영용 패키지를 찾지 못했습니다. npm install을 먼저 하세요.');
  for (const dir of prodDirs) walk(dir, { skipNodeModules: true }).forEach((f) => files.add(f));
  return [...files].sort();
}

/** [머리글 길이 4바이트][머리글 JSON: [[경로, 크기], …]][파일 내용…] → brotli 압축 */
function pack(files) {
  const index = [];
  const bodies = [];
  for (const file of files) {
    const data = fs.readFileSync(file);
    index.push([path.relative(root, file).split(path.sep).join('/'), data.length]);
    bodies.push(data);
  }
  const header = Buffer.from(JSON.stringify(index), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const raw = Buffer.concat([len, header, ...bodies]);
  const packed = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  return { raw, packed };
}

function findCloudflared() {
  const dirs = [process.env.ESIGN_CLOUDFLARED && path.dirname(process.env.ESIGN_CLOUDFLARED), 'C:\\Program Files (x86)\\cloudflared', 'C:\\Program Files\\cloudflared',
    ...String(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'cloudflared.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') throw new Error('Windows에서 실행해 주세요 (Windows용 exe를 만듭니다).');
  const { version } = require(path.join(root, 'package.json'));
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = collectFiles();
  const { raw, packed } = pack(files);
  const id = `${version}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  fs.writeFileSync(path.join(work, 'app.bin'), packed);
  fs.writeFileSync(path.join(work, 'app-id.txt'), id);
  console.log(`앱 파일 ${files.length}개 · ${(raw.length / 1e6).toFixed(1)}MB → 압축 ${(packed.length / 1e6).toFixed(1)}MB (버전 ${id})`);

  const exePath = path.join(outDir, 'eSign.exe');
  const config = {
    main: path.join(__dirname, 'exe', 'sea-main.js'),
    output: exePath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { app: path.join(work, 'app.bin'), 'app-id': path.join(work, 'app-id.txt') },
  };
  const configPath = path.join(work, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  execFileSync(process.execPath, ['--build-sea', configPath], { stdio: 'inherit' });
  if (!fs.existsSync(exePath)) throw new Error('eSign.exe가 만들어지지 않았습니다.');

  const cloudflared = findCloudflared();
  if (cloudflared) fs.copyFileSync(cloudflared, path.join(outDir, 'cloudflared.exe'));
  else console.warn('⚠ cloudflared.exe를 찾지 못해 넣지 않았습니다 (winget install --id Cloudflare.cloudflared 후 다시 빌드).');
  fs.copyFileSync(path.join(__dirname, 'exe', '사용법.txt'), path.join(outDir, '사용법.txt'));

  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${outDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`], { stdio: 'inherit' });
  fs.rmSync(work, { recursive: true, force: true });

  for (const f of fs.readdirSync(outDir)) console.log(`  ${f}  ${(fs.statSync(path.join(outDir, f)).size / 1e6).toFixed(1)}MB`);
  console.log(`완료: ${outDir}\n배포용 압축 파일: ${zipPath} (${(fs.statSync(zipPath).size / 1e6).toFixed(1)}MB)`);
}

main();
