'use strict';
// 관리자 설정 (data/settings.json): 서명 링크 주소, 메일 발송(SMTP) 계정, 타임스탬프(TSA)
// 메일 비밀번호는 API로 절대 내보내지 않는다. 파일 권한 600.
const fs = require('fs');
const path = require('path');
const { DEFAULT_TSA_URL } = require('./tsa');

const MAIL_PRESETS = {
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'ssl', help: 'Google 계정 → 보안 → 2단계 인증을 켠 뒤 "앱 비밀번호"를 만들어 비밀번호 칸에 넣으세요.' },
  naver: { label: '네이버 메일', host: 'smtp.naver.com', port: 465, security: 'ssl', help: '네이버 메일 → 환경설정 → POP3/IMAP 설정에서 "IMAP/SMTP 사용"을 켜세요. 2단계 인증 중이면 애플리케이션 비밀번호를 쓰세요.' },
  daum: { label: '다음/카카오 메일', host: 'smtp.daum.net', port: 465, security: 'ssl', help: '다음 메일 → 환경설정 → IMAP/SMTP 사용을 켜세요. 2단계 인증 중이면 앱 비밀번호를 쓰세요.' },
  outlook: { label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls', help: '회사 계정은 관리자가 SMTP 인증을 허용해야 할 수 있습니다.' },
  custom: { label: '직접 입력 (회사 메일 서버 등)', help: '메일 담당자에게 SMTP 서버 주소·포트·보안 방식을 받아 입력하세요.' },
};

function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data.mail ||= {};

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  return {
    publicUrl: () => data.publicUrl || '',
    mail: () => data.mail,
    /** 타임스탬프 기관 주소 (꺼져 있으면 '') */
    tsaUrl: () => (data.tsa?.enabled && data.tsa.url) || '',
    mailConfigured: () => Boolean(data.mail.host && (data.mail.fromEmail || data.mail.user)),
    /** 화면에 보여줄 값 (비밀번호 제외) */
    view() {
      const { pass, ...mail } = data.mail;
      return {
        publicUrl: data.publicUrl || '',
        mail: { ...mail, hasPassword: Boolean(pass) },
        tsa: { enabled: Boolean(data.tsa?.enabled), url: data.tsa?.url || DEFAULT_TSA_URL, defaultUrl: DEFAULT_TSA_URL },
        presets: MAIL_PRESETS,
      };
    },
    /** 이미 검사된 값만 넘겨야 한다 */
    update({ publicUrl, mail, tsa }) {
      if (publicUrl !== undefined) data.publicUrl = publicUrl;
      if (tsa) data.tsa = tsa;
      if (mail) {
        const { pass, clearPass, ...rest } = mail;
        const keep = clearPass ? undefined : (pass || data.mail.pass);
        data.mail = { ...rest, ...(keep ? { pass: keep } : {}) };
      }
      save();
    },
  };
}

module.exports = { createSettings, MAIL_PRESETS };
