'use strict';
// 새 서명 요청의 교육생 명단: CSV 파일·엑셀 붙여넣기 해석 (public/js/roster.js — 브라우저 모듈을 그대로 불러 시험)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/roster.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

test('머리글이 있는 CSV: 열 순서가 달라도 머리글로 칸을 맞추고, 번호 열은 무시', async () => {
  const { parseCsv, rowsToMembers } = await load();
  const csv = '번호,전화번호,이름,이메일,소속\r\n1,010-1234-5678,김교육,kim@example.com,1반\r\n2,010-2222-3333,이수강,,\r\n';
  assert.deepEqual(rowsToMembers(parseCsv(csv)), [
    { name: '김교육', org: '1반', phone: '010-1234-5678', email: 'kim@example.com' },
    { name: '이수강', org: '', phone: '010-2222-3333', email: '' },
  ]);
});

test('따옴표 안의 쉼표·줄바꿈·"" 와 BOM, 빈 줄 처리', async () => {
  const { parseCsv } = await load();
  const csv = '﻿이름,소속\n"박서명","교육팀, 2반"\n\n"최""별명""",  "여러\n줄"  \n';
  assert.deepEqual(parseCsv(csv), [['이름', '소속'], ['박서명', '교육팀, 2반'], ['최"별명"', '여러 줄']]);
});

test('엑셀 한글 CSV(CP949)도 읽고, 엑셀이 지운 휴대폰 앞자리 0을 되살린다', async () => {
  const { decodeCsvBytes, parseCsv, rowsToMembers } = await load();
  // "이름,전화번호\r\n김교육,1012345678\r\n" 을 CP949로 저장한 바이트
  const bytes = Uint8Array.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xc0, 0xfc, 0xc8, 0xad, 0xb9, 0xf8, 0xc8, 0xa3, 0x0d, 0x0a,
    0xb1, 0xe8, 0xb1, 0xb3, 0xc0, 0xb0, 0x2c, ...Buffer.from('1012345678\r\n')]);
  const text = decodeCsvBytes(bytes);
  assert.equal(text.split('\r\n')[0], '이름,전화번호');
  assert.deepEqual(rowsToMembers(parseCsv(text)), [{ name: '김교육', org: '', phone: '01012345678', email: '' }]);
  // UTF-8(BOM 포함)도 그대로
  assert.equal(decodeCsvBytes(Buffer.from('﻿이름\n', 'utf8')), '이름\n');
});

test('머리글 없는 붙여넣기(탭·쉼표): 이메일은 @, 전화번호는 숫자로 알아보고 첫 글자 칸이 이름', async () => {
  const { parseCsv, rowsToMembers } = await load();
  assert.deepEqual(rowsToMembers(parseCsv('김교육\tkim@example.com\t010-1234-5678\t1반\n')), [
    { name: '김교육', org: '1반', phone: '010-1234-5678', email: 'kim@example.com' },
  ]);
  assert.deepEqual(rowsToMembers(parseCsv('3,박서명,2반,010-4444-5555\n')), [
    { name: '박서명', org: '2반', phone: '010-4444-5555', email: '' },
  ]);
  assert.deepEqual(rowsToMembers(parseCsv('홍길동\n')), [{ name: '홍길동', org: '', phone: '', email: '' }]);
});

test('줄마다 문제 찾기: 이름 없음·전화번호(본인 확인 시)·이메일 형식', async () => {
  const { memberProblems } = await load();
  assert.deepEqual(memberProblems({ name: '', org: '', phone: '', email: '' }, { requirePhone: true }), {}, '빈 줄은 문제 없음');
  assert.deepEqual(memberProblems({ name: '', phone: '010-1234-5678' }), { name: '이름이 없습니다' });
  assert.ok(memberProblems({ name: '김교육' }, { requirePhone: true }).phone);
  assert.deepEqual(memberProblems({ name: '김교육' }, { requirePhone: false }), {});
  assert.ok(memberProblems({ name: '김교육', phone: '010-12' }, { requirePhone: true }).phone);
  assert.ok(memberProblems({ name: '김교육', phone: '공일공' }).phone);
  assert.ok(memberProblems({ name: '김교육', email: 'kim@example' }).email);
});

test('양식 CSV는 머리글 4칸 + 예시이고, 다시 불러오면 그대로 읽힌다', async () => {
  const { rosterCsvTemplate, parseCsv, rowsToMembers, headerMap } = await load();
  const rows = parseCsv(rosterCsvTemplate());
  assert.deepEqual(rows[0], ['이름', '소속', '전화번호', '이메일']);
  assert.ok(headerMap(rows[0]));
  assert.equal(rowsToMembers(rows)[0].email, 'kim@example.com');
});
