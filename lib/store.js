'use strict';
// 아주 단순한 JSON 파일 저장소. (MVP용 — 실제 서비스에서는 DB로 교체)
const fs = require('fs');
const path = require('path');

function createStore(dataDir) {
  const filesDir = path.join(dataDir, 'files');
  const dbPath = path.join(dataDir, 'db.json');
  fs.mkdirSync(filesDir, { recursive: true });

  const db = fs.existsSync(dbPath)
    ? JSON.parse(fs.readFileSync(dbPath, 'utf8'))
    : { documents: [] };
  db.groups ||= []; // 교육생 일괄 서명 요청 (예전 db.json에는 없음)

  return {
    documents: () => db.documents,
    findDocument: (id) => db.documents.find((d) => d.id === id),
    groups: () => db.groups,
    findGroup: (id) => db.groups.find((g) => g.id === id),
    addGroup(group) {
      db.groups.push(group);
      this.save();
    },
    findBySignerToken(token) {
      for (const doc of db.documents) {
        const signer = doc.signers.find((s) => s.token === token);
        if (signer) return { doc, signer };
      }
      return null;
    },
    addDocument(doc) {
      db.documents.push(doc);
      this.save();
    },
    // 임시 파일에 쓴 뒤 rename → 저장 도중 꺼져도 db.json이 깨지지 않음
    save() {
      const tmp = `${dbPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, dbPath);
    },
    filePath: (name) => path.join(filesDir, path.basename(name)),
  };
}

module.exports = { createStore };
