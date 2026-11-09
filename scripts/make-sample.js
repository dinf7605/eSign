'use strict';
// 테스트용 한글 샘플 계약서 PDF를 만든다: node scripts/make-sample.js
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT = process.env.ESIGN_FONT || 'C:/Windows/Fonts/malgun.ttf';

(async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(FONT), { subset: true });

  const page1 = pdf.addPage([595.28, 841.89]);
  let y = 770;
  const line = (page, text, size = 11, gap = 22) => {
    page.drawText(text, { x: 60, y, size, font, color: rgb(0.1, 0.1, 0.15) });
    y -= gap;
  };
  line(page1, '용역 계약서 (샘플)', 22, 46);
  [
    '갑(위탁자)과 을(수탁자)은 다음과 같이 용역 계약을 체결한다.',
    '',
    '제1조 (목적) 본 계약은 갑이 을에게 웹 서비스 개발 용역을 맡기고,',
    '          을은 이를 성실히 수행하는 데 필요한 사항을 정한다.',
    '제2조 (기간) 계약 기간은 2026년 12월 1일부터 2027년 2월 28일까지로 한다.',
    '제3조 (대금) 용역 대금은 총 금 일천만원(₩10,000,000)으로 한다.',
    '제4조 (비밀유지) 양 당사자는 업무상 알게 된 비밀을 누설하지 않는다.',
  ].forEach((t) => line(page1, t));

  const page2 = pdf.addPage([595.28, 841.89]);
  y = 770;
  line(page2, '제5조 (기타) 본 계약에 정하지 않은 사항은 상호 협의하여 정한다.');
  y -= 40;
  line(page2, '위 계약을 증명하기 위하여 계약서를 작성하고 서명한다.', 11, 70);
  line(page2, '갑 (위탁자)                                    을 (수탁자)', 12, 30);
  line(page2, '성명: ________________                    성명: ________________', 11, 60);
  line(page2, '서명:                                           서명:', 11, 30);

  const out = path.join(__dirname, '..', 'public', 'samples', 'sample-contract.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await pdf.save());
  console.log('생성됨:', out);
})();
