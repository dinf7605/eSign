'use strict';
// 서명자 명단 만들기: PDF 표 + 엑셀(.xlsx)
const { PDFDocument, rgb } = require('pdf-lib');
const { embedFont, sealPdf, formatKST } = require('./finalize');
const { createXlsx } = require('./xlsx');
const { maskPhone } = require('./phone');

const A4 = [595.28, 841.89];
const MARGIN = 40;
const ROW_H = 40;
const HEADER_H = 24;
const COLS = [
  { key: 'no', label: '번호', width: 32, align: 'center' },
  { key: 'name', label: '이름', width: 74 },
  { key: 'org', label: '소속', width: 92 },
  { key: 'phone', label: '연락처', width: 92, align: 'center' },
  { key: 'signedAt', label: '서명 일시', width: 96, align: 'center' },
  { key: 'signature', label: '서명', width: 129.28 },
]; // 합계 515.28 = A4 폭 - 여백 2개

const GRID = rgb(0.72, 0.75, 0.82);
const INK = rgb(0.1, 0.12, 0.2);
const MUTED = rgb(0.45, 0.47, 0.55);


function shortKST(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

/**
 * @param {object} p
 * @param {{title: string, info?: string}} p.group
 * @param {{no: number, name: string, org?: string, phone?: string, signed: boolean, signedAt?: string, signaturePng?: Buffer|null}[]} p.rows
 * @param {boolean} p.signedOnly true면 "서명자 명단", false면 미서명자까지 "서명 현황"
 */
async function buildRosterPdf({ group, rows, seal, signedOnly, generatedAt = new Date(), tsa }) {
  const pdf = await PDFDocument.create();
  const { font, unicode } = await embedFont(pdf);
  const clean = (s) => (unicode ? String(s ?? '') : String(s ?? '').replace(/[^\x20-\x7E]/g, '?'));
  const heading = signedOnly ? '서명자 명단' : '서명 현황';
  pdf.setTitle(`${heading} - ${group.title}`);

  // 칸 너비에 맞게 글자 크기를 줄이고, 그래도 넘치면 말줄임
  const fit = (text, maxWidth, size) => {
    let t = clean(text);
    let s = size;
    while (s > 6.5 && font.widthOfTextAtSize(t, s) > maxWidth) s -= 0.5;
    while (t.length > 1 && font.widthOfTextAtSize(t, s) > maxWidth) t = `${t.slice(0, -2)}…`;
    return { t, s };
  };

  const pages = [];
  let page;
  let y;

  const drawTableHeader = () => {
    let x = MARGIN;
    page.drawRectangle({ x, y: y - HEADER_H, width: A4[0] - MARGIN * 2, height: HEADER_H, color: rgb(0.93, 0.95, 0.98), borderColor: GRID, borderWidth: 0.6 });
    for (const c of COLS) {
      const tw = font.widthOfTextAtSize(c.label, 9.5);
      page.drawText(c.label, { x: x + (c.width - tw) / 2, y: y - HEADER_H + 8, size: 9.5, font, color: INK });
      x += c.width;
    }
    y -= HEADER_H;
  };

  const newPage = (first) => {
    page = pdf.addPage(A4);
    pages.push(page);
    y = A4[1] - MARGIN;
    if (first) {
      page.drawText(heading, { x: (A4[0] - font.widthOfTextAtSize(heading, 22)) / 2, y: y - 22, size: 22, font, color: INK });
      y -= 44;
      const sub = fit(group.title, A4[0] - MARGIN * 2, 13);
      page.drawText(sub.t, { x: (A4[0] - font.widthOfTextAtSize(sub.t, sub.s)) / 2, y, size: sub.s, font, color: INK });
      y -= 24;
      for (const line of String(group.info || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)) {
        const l = fit(line, A4[0] - MARGIN * 2, 10);
        page.drawText(l.t, { x: MARGIN, y, size: l.s, font, color: INK });
        y -= 15;
      }
      const summary = `${group.summary} · 출력 ${formatKST(generatedAt.toISOString())}`;
      page.drawText(clean(summary), { x: MARGIN, y, size: 9, font, color: MUTED });
      y -= 14;
    } else {
      const head = fit(`${heading} · ${group.title}`, A4[0] - MARGIN * 2, 9);
      page.drawText(head.t, { x: MARGIN, y: y - 9, size: head.s, font, color: MUTED });
      y -= 18;
    }
    drawTableHeader();
  };

  newPage(true);
  for (const r of rows) {
    if (y - ROW_H < MARGIN + 30) newPage(false);
    let x = MARGIN;
    const top = y;
    const values = {
      no: String(r.no),
      name: r.name,
      org: r.org || '',
      phone: maskPhone(r.phone),
      signedAt: r.signed ? shortKST(r.signedAt) : '미서명',
    };
    for (const c of COLS) {
      page.drawRectangle({ x, y: top - ROW_H, width: c.width, height: ROW_H, borderColor: GRID, borderWidth: 0.6 });
      if (c.key === 'signature') {
        if (r.signed && r.signaturePng) {
          const img = await pdf.embedPng(r.signaturePng);
          const pad = 3;
          const scale = Math.min((c.width - pad * 2) / img.width, (ROW_H - pad * 2) / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { x: x + (c.width - w) / 2, y: top - ROW_H + (ROW_H - h) / 2, width: w, height: h });
        }
      } else {
        const v = fit(values[c.key], c.width - 8, ['signedAt', 'phone'].includes(c.key) ? 8.5 : 10);
        const tw = font.widthOfTextAtSize(v.t, v.s);
        const tx = c.align === 'center' ? x + (c.width - tw) / 2 : x + 5;
        const color = c.key === 'signedAt' && !r.signed ? rgb(0.75, 0.2, 0.2) : INK;
        page.drawText(v.t, { x: tx, y: top - ROW_H / 2 - v.s * 0.36, size: v.s, font, color });
      }
      x += c.width;
    }
    y -= ROW_H;
  }
  if (rows.length === 0) {
    page.drawText(signedOnly ? '아직 서명한 사람이 없습니다.' : '명단이 없습니다.', { x: MARGIN + 5, y: y - 20, size: 10, font, color: MUTED });
  }

  const note = '※ 연락처는 일부를 가렸습니다. 각 서명은 개인별 "서명 완료 PDF"(본인 확인·전자서명·감사 추적 포함)에 보관되며, 이 명단 PDF에도 전자서명이 들어 있습니다.';
  pages.forEach((p, i) => {
    const footer = `${i + 1} / ${pages.length}`;
    p.drawText(footer, { x: (A4[0] - font.widthOfTextAtSize(footer, 8.5)) / 2, y: 22, size: 8.5, font, color: MUTED });
    if (i === pages.length - 1) {
      const n = fit(note, A4[0] - MARGIN * 2, 7.5);
      p.drawText(n.t, { x: MARGIN, y: 36, size: n.s, font, color: MUTED });
    }
  });

  return sealPdf(pdf, seal, { page: pages[pages.length - 1], reason: `${heading} 발급`, signingTime: generatedAt, tsa });
}

const STATUS = (r) => (r.signed ? '서명 완료' : r.verifiedAt ? '본인 확인 후 미서명' : '미서명');
const EMAIL = (r) => {
  if (r.emailStatus === 'sent') return `발송 ${formatKST(r.emailSentAt)}`;
  if (r.emailStatus === 'failed') return `실패: ${r.emailError || ''}`;
  return r.email ? '안 보냄' : '이메일 없음';
};

/** 엑셀 명단 (.xlsx) */
function buildRosterXlsx(rows, { signedOnly }) {
  return createXlsx({
    sheetName: signedOnly ? '서명자 명단' : '서명 현황',
    columns: [
      { header: '번호', width: 6 },
      { header: '이름', width: 12 },
      { header: '소속', width: 14 },
      { header: '연락처', width: 15 },
      { header: '이메일', width: 26 },
      { header: '상태', width: 16 },
      { header: '서명 일시', width: 24 },
      { header: '본인 확인', width: 24 },
      { header: '메일', width: 28 },
      { header: '서명 IP', width: 16 },
      { header: '서명 완료 PDF SHA-256', width: 30 },
      ...(signedOnly ? [] : [{ header: '서명 링크', width: 40 }]),
    ],
    rows: rows.map((r) => [
      r.no, r.name, r.org, r.phone, r.email, STATUS(r),
      r.signedAt ? formatKST(r.signedAt) : '',
      r.verifiedAt ? `이름·전화번호 일치 ${formatKST(r.verifiedAt)}` : '',
      EMAIL(r),
      r.ip, r.completedHash,
      ...(signedOnly ? [] : [r.signed ? '' : r.signLink]),
    ]),
  });
}

module.exports = { buildRosterPdf, buildRosterXlsx, maskPhone };
