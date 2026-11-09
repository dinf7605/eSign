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
  db.templates ||= []; // 자주 쓰는 문서 + 칸 배치 (예전 db.json에는 없음)
  db.deletions ||= []; // 파기 기록 (개인정보 없이 무엇을 언제 지웠는지만)

  return {
    deletions: () => db.deletions,
    addDeletion(entry) {
      db.deletions.push(entry);
      if (db.deletions.length > 1000) db.deletions.splice(0, db.deletions.length - 1000);
      this.save();
    },
    /** 문서 여러 개를 한 번에 지운다 (저장 1번) */
    removeDocuments(ids) {
      db.documents = db.documents.filter((d) => !ids.has(d.id));
      this.save();
    },
    removeGroup(id) {
      db.groups = db.groups.filter((g) => g.id !== id);
      this.save();
    },
    templates: () => db.templates,
    findTemplate: (id) => db.templates.find((t) => t.id === id),
    addTemplate(template) {
      db.templates.push(template);
      this.save();
    },
    removeTemplate(id) {
      db.templates = db.templates.filter((t) => t.id !== id);
      this.save();
    },
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
