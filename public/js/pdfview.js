// PDF.js로 PDF의 모든 페이지를 그리고, 각 페이지 위에 서명란을 올릴 오버레이를 만든다.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { h } from './common.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

/**
 * 모든 페이지의 자리(크기·오버레이)를 먼저 만들어 바로 돌려주고, 그림은 뒤이어 그린다.
 * → 문서가 길어도 서명란을 곧바로 올릴 수 있다.
 * @param {HTMLElement} container
 * @param {Uint8Array|string} source PDF 바이트 또는 URL
 * @returns {Promise<{pages: {number:number, el:HTMLElement, overlay:HTMLElement, aspect:number}[], rendered: Promise<void>}>}
 */
export async function renderPdf(container, source) {
  container.replaceChildren(h('div', { class: 'loading' }, '문서를 불러오는 중…'));
  const params = {
    cMapUrl: '/vendor/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs-fonts/',
    wasmUrl: '/vendor/pdfjs-wasm/',
    iccUrl: '/vendor/pdfjs-iccs/',
    ...(typeof source === 'string' ? { url: source } : { data: source }),
  };
  const pdf = await pdfjsLib.getDocument(params).promise;
  container.replaceChildren();

  const pages = [];
  const jobs = [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = Math.min(container.clientWidth || 820, 820);
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 }); // 회전(/Rotate)이 반영된 보기
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

    const canvas = h('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    const overlay = h('div', { class: 'pdf-overlay' });
    const el = h('div', { class: 'pdf-page', 'data-page': n, style: { aspectRatio: `${base.width} / ${base.height}` } },
      canvas, overlay, h('div', { class: 'pdf-page-num' }, `${n} / ${pdf.numPages}`));
    container.append(el);
    pages.push({ number: n, el, overlay, aspect: base.width / base.height });
    jobs.push({ page, canvas, viewport });
  }

  const rendered = (async () => {
    for (const { page, canvas, viewport } of jobs) {
      await page.render({ canvas, viewport }).promise;
    }
  })();
  rendered.catch((err) => console.error('PDF 페이지 그리기 실패', err));
  return { pages, rendered };
}
