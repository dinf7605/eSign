'use strict';
// 모든 서명이 끝나면: 원본 PDF에 서명 이미지를 넣고, 마지막에 "감사 추적 인증서" 페이지를 붙인다.
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { default: signpdf } = require('@signpdf/signpdf');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { SUBFILTER_ETSI_CADES_DETACHED } = require('@signpdf/utils');
const { CadesSigner } = require('./cades');

const FONT_CANDIDATES = [
  process.env.ESIGN_FONT,
  'C:/Windows/Fonts/malgun.ttf',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/Library/Fonts/NanumGothic.ttf',
].filter(Boolean);

const EVENT_LABELS = {
  created: '문서 생성',
  email_sent: '서명 요청 메일 발송',
  email_failed: '메일 발송 실패',
  verify_failed: '본인 확인 실패',
  verified: '본인 확인 (이름·전화번호 일치)',
  viewed: '문서 열람',
  signed: '서명 완료',
  completed: '모든 서명 완료',
  timestamped: '타임스탬프 발급 (RFC 3161)',
  timestamp_failed: '타임스탬프 실패 — 타임스탬프 없이 봉인',
};

async function embedFont(pdf) {
  const fontPath = FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (fontPath) {
    pdf.registerFontkit(fontkit);
    return { font: await pdf.embedFont(fs.readFileSync(fontPath), { subset: true }), unicode: true };
  }
  // 한글 폰트가 없으면 영문 폰트로 대체 (한글은 ?로 표시됨) → ESIGN_FONT 환경변수로 폰트 지정 권장
  return { font: await pdf.embedFont(StandardFonts.Helvetica), unicode: false };
}

/**
 * 화면 기준 비율 좌표(왼쪽 위 원점, 회전 반영된 보기)를 PDF 좌표로 바꾼다.
 * 페이지에 /Rotate가 있어도 서명이 화면에서 본 위치·방향 그대로 찍히도록 처리.
 */
function placeField(page, f) {
  const box = page.getCropBox();
  const W = box.width;
  const H = box.height;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const u = f.x; // 화면상 서명란의 왼쪽 아래 모서리
  const v = f.y + f.h;
  let X;
  let Y;
  let width;
  let height;
  switch (rot) {
    case 90:
      X = v * W; Y = u * H; width = f.w * H; height = f.h * W; break;
    case 180:
      X = W - u * W; Y = v * H; width = f.w * W; height = f.h * H; break;
    case 270:
      X = W - v * W; Y = H - u * H; width = f.w * H; height = f.h * W; break;
    default:
      X = u * W; Y = H - v * H; width = f.w * W; height = f.h * H;
  }
  return { x: box.x + X, y: box.y + Y, width, height, rotate: degrees(rot) };
}

function formatKST(iso) {
  if (!iso) return '-';
  return `${new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} (KST)`;
}

/** 감사 추적 페이지를 그리는 간단한 문단 작성기 (자동 줄바꿈·페이지 넘김) */
class AuditWriter {
  constructor(pdf, font, unicode) {
    this.pdf = pdf;
    this.font = font;
    this.unicode = unicode;
    this.margin = 50;
    this.size = [595.28, 841.89]; // A4
    this.newPage();
  }

  clean(text) {
    const s = String(text ?? '');
    return this.unicode ? s : s.replace(/[^\x20-\x7E]/g, '?');
  }

  newPage() {
    this.page = this.pdf.addPage(this.size);
    this.y = this.size[1] - this.margin;
  }

  ensure(height) {
    if (this.y - height < this.margin) this.newPage();
  }

  wrap(text, fontSize, maxWidth) {
    const lines = [];
    for (const para of this.clean(text).split('\n')) {
      let line = '';
      for (const ch of para) {
        const next = line + ch;
        if (line && this.font.widthOfTextAtSize(next, fontSize) > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(text, { size = 10, color = rgb(0.15, 0.15, 0.2), indent = 0, gap = 4 } = {}) {
    const maxWidth = this.size[0] - this.margin * 2 - indent;
    for (const line of this.wrap(text, size, maxWidth)) {
      this.ensure(size + gap);
      this.y -= size;
      this.page.drawText(line, { x: this.margin + indent, y: this.y, size, font: this.font, color });
      this.y -= gap;
    }
  }

  row(label, value) {
    const labelWidth = 90;
    const maxWidth = this.size[0] - this.margin * 2 - labelWidth;
    const lines = this.wrap(value, 9.5, maxWidth);
    this.ensure(lines.length * 14);
    this.y -= 9.5;
    this.page.drawText(this.clean(label), { x: this.margin, y: this.y, size: 9.5, font: this.font, color: rgb(0.45, 0.45, 0.5) });
    lines.forEach((line, i) => {
      if (i > 0) this.y -= 13.5;
      this.page.drawText(line, { x: this.margin + labelWidth, y: this.y, size: 9.5, font: this.font, color: rgb(0.1, 0.1, 0.15) });
    });
    this.y -= 5;
  }

  heading(text) {
    this.ensure(40);
    this.y -= 14;
    this.text(text, { size: 12.5, color: rgb(0.1, 0.25, 0.6), gap: 4 });
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.size[0] - this.margin, y: this.y },
      thickness: 0.6,
      color: rgb(0.8, 0.83, 0.9),
    });
    this.y -= 8;
  }
}

/**
 * @param {object} p
 * @param {Uint8Array} p.originalBytes
 * @param {object} p.doc 문서 레코드
 * @param {(field) => Buffer} p.readSignature 서명란의 PNG 바이트를 돌려주는 함수
 * @param {string} p.consentText
 * @param {object} p.seal loadOrCreateSeal() 결과 — 최종 PDF에 PAdES 전자서명(봉인)을 넣는다
 * @param {{url: string, onResult?: Function}} [p.tsa] 타임스탬프 기관(TSA) — 있으면 봉인에 RFC 3161 타임스탬프를 붙인다
 */
async function buildCompletedPdf({ originalBytes, doc, readSignature, consentText, seal, tsa }) {
  const pdf = await PDFDocument.load(originalBytes);
  const pages = pdf.getPages();
  const { font, unicode } = await embedFont(pdf);
  const clean = (s) => (unicode ? String(s) : String(s).replace(/[^\x20-\x7E]/g, '?'));

  for (const field of doc.fields) {
    const page = pages[field.page - 1];
    const signer = doc.signers.find((s) => s.id === field.signerId);
    const type = field.type || 'signature';
    if (type === 'signature') {
      const png = await pdf.embedPng(readSignature(field));
      page.drawImage(png, placeField(page, field));
    } else if (type === 'name') {
      drawFieldText(page, field, clean(signer.name), font);
    } else if (type === 'date') {
      drawFieldText(page, field, formatDateKST(signer.signedAt), font);
    }
  }

  const w = new AuditWriter(pdf, font, unicode);

  w.text('전자서명 감사 추적 인증서', { size: 20, color: rgb(0.08, 0.12, 0.25), gap: 6 });
  w.text('Audit Trail Certificate', { size: 10, color: rgb(0.45, 0.45, 0.5), gap: 10 });

  w.heading('문서 정보');
  w.row('문서 제목', doc.title);
  w.row('문서 ID', doc.id);
  w.row('원본 파일명', doc.fileName);
  w.row('원본 페이지 수', `${doc.pageCount}쪽 (이 인증서 페이지 제외)`);
  w.row('원본 SHA-256', doc.originalHash);
  w.row('생성 일시', formatKST(doc.createdAt));
  w.row('완료 일시', formatKST(doc.completedAt));

  w.heading(`서명자 (${doc.signers.length}명)`);
  doc.signers.forEach((s, i) => {
    w.text(`${i + 1}. ${s.name}${s.org ? ` (${s.org})` : ''}${s.email ? `  <${s.email}>` : ''}`, { size: 10.5, gap: 5 });
    w.row('서명 일시', formatKST(s.signedAt));
    w.row('본인 확인', s.verifiedAt
      ? `이름·전화번호 일치 확인 (${formatKST(s.verifiedAt)})`
      : doc.requireVerification ? '-' : '없음 (서명 링크 소지자)');
    if (s.emailSentAt) w.row('요청 메일', `${s.email} 로 발송 (${formatKST(s.emailSentAt)})`);
    w.row('IP 주소', s.ip || '-');
    w.row('브라우저', s.userAgent || '-');
    w.row('서명란 수', `${doc.fields.filter((f) => f.signerId === s.id && (f.type || 'signature') === 'signature').length}개`);
    w.row('동의 문구', consentText);
  });

  w.heading('이벤트 기록');
  for (const e of doc.events) {
    const who = e.name ? ` · ${e.name}` : '';
    const ip = e.ip ? ` · IP ${e.ip}` : '';
    w.text(`${formatKST(e.at)}  ${EVENT_LABELS[e.type] || e.type}${who}${ip}`, { size: 9, gap: 4 });
  }

  w.heading('전자서명(봉인) 정보');
  w.row('서명 형식', tsa?.url
    ? 'PAdES Baseline B-T (ETSI.CAdES.detached, SHA-256 / RSA + RFC 3161 타임스탬프)'
    : 'PAdES Baseline B-B (ETSI.CAdES.detached, SHA-256 / RSA)');
  if (tsa?.url) w.row('타임스탬프', `${tsa.url} 에 요청 (결과는 "문서 검증"에서 확인)`);
  w.row('봉인 인증서', seal.info.subject);
  w.row('발급 기관', `${seal.info.issuer}${seal.selfIssued ? ' (자체 발급)' : ''}`);
  w.row('인증서 지문', seal.info.fingerprint256);
  w.row('유효 기간', `${formatKST(seal.info.validFrom)} ~ ${formatKST(seal.info.validTo)}`);

  w.heading('검증 방법');
  w.text(
    '이 PDF 전체에는 위 봉인 인증서로 전자서명이 들어 있습니다. Adobe Acrobat Reader의 "서명 패널"에서 서명을 확인할 수 있고, '
      + '서명 이후 파일이 한 글자라도 바뀌면 서명이 깨진 것으로 표시됩니다. '
      + '서비스의 "문서 검증" 페이지에서도 전자서명과 SHA-256 해시를 함께 확인할 수 있습니다.',
    { size: 9, color: rgb(0.35, 0.35, 0.4) },
  );
  if (seal.selfIssued) {
    w.text(
      '※ 자체 발급 인증서이므로 Adobe에서는 처음에 "서명자 신원을 알 수 없음"으로 표시됩니다. '
        + '서비스에서 루트 인증서를 내려받아 신뢰할 수 있는 인증서로 추가하면 정상(초록색)으로 표시됩니다.',
      { size: 9, color: rgb(0.55, 0.35, 0.1) },
    );
  }

  return sealPdf(pdf, seal, {
    page: w.page,
    reason: '모든 서명자의 서명 완료 — 문서 봉인',
    signingTime: new Date(doc.completedAt),
    tsa,
  });
}

/**
 * pdf-lib 문서 전체에 PAdES 전자서명(봉인)을 넣고 최종 바이트를 돌려준다.
 * 보이지 않는 서명 필드를 지정한 페이지에 달고, 서명값 자리를 비워 둔 채 저장한 뒤 서명한다.
 */
async function sealPdf(pdf, seal, { page, reason, signingTime = new Date(), tsa }) {
  pdf.setProducer('esign MVP (pdf-lib, @signpdf)');
  pdf.setModificationDate(signingTime);
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    pdfPage: page,
    reason,
    contactInfo: '',
    name: seal.info.subject,
    location: 'KR',
    signingTime,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    appName: 'e서명',
    // 서명값 자리(바이트): 타임스탬프 토큰(TSA 인증서 체인 포함 보통 5~8KB)이 들어갈 여유를 둔다
    signatureLength: tsa?.url ? 24576 : 8192,
  });
  const unsigned = await pdf.save({ useObjectStreams: false });
  return signpdf.sign(Buffer.from(unsigned), new CadesSigner(seal, { tsa }));
}

function formatDateKST(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 자동 입력 칸(이름·날짜)에 글자를 상자 크기에 맞춰 가운데 정렬로 쓴다 (회전 페이지 포함) */
function drawFieldText(page, field, text, font) {
  if (!text) return;
  const p = placeField(page, field);
  let size = Math.min(p.height * 0.6, 28);
  const width = font.widthOfTextAtSize(text, size);
  if (width > p.width * 0.94) size *= (p.width * 0.94) / width;
  const textWidth = font.widthOfTextAtSize(text, size);
  const dx = (p.width - textWidth) / 2;
  const dy = (p.height - size * 0.72) / 2; // 글자 높이 ≈ 0.72em 기준으로 세로 가운데
  const rad = (p.rotate.angle * Math.PI) / 180;
  page.drawText(text, {
    x: p.x + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: p.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    size,
    font,
    rotate: p.rotate,
    color: rgb(0.08, 0.1, 0.25),
  });
}

module.exports = { buildCompletedPdf, placeField, sealPdf, embedFont, formatKST, formatDateKST };
