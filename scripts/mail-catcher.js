'use strict';
// 메일 연습용 가짜 메일 서버: 실제로 보내지 않고 받은 메일을 파일(.eml)로 저장한다.
//   npm run mail-catcher       (기본 포트 2525, 저장 폴더 esign/.mail-catcher)
// 설정 화면 → 메일 서비스 "직접 입력" → SMTP 서버 127.0.0.1, 포트 2525, 보안 "없음", 보내는 사람 이메일 아무 주소
// 저장된 .eml 파일은 Outlook·Windows 메일에서 더블클릭으로 열어 볼 수 있다.
const fs = require('fs');
const path = require('path');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 2525;
const dir = path.resolve((process.argv.find((a) => a.startsWith('--dir=')) || '').split('=').slice(1).join('=') || path.join(__dirname, '..', '.mail-catcher'));
fs.mkdirSync(dir, { recursive: true });
let count = 0;

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, session, cb) { cb(null, { user: auth.username }); }, // 아무 계정이나 통과
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', async () => {
      const raw = Buffer.concat(chunks);
      count += 1;
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${count}.eml`);
      fs.writeFileSync(file, raw);
      const mail = await simpleParser(raw);
      console.log(`📨 ${mail.to?.text} ← "${mail.subject}"  (${path.basename(file)})`);
      cb();
    });
  },
});

server.listen(port, '127.0.0.1', () => {
  console.log(`가짜 메일 서버 실행 중: 127.0.0.1:${port}`);
  console.log(`받은 메일 저장 폴더: ${dir}`);
});
