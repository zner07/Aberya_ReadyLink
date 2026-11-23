
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('./data/readylink.db', {
  readOnly: true
});

try {
  const reports = db.prepare(`
    SELECT public_id, type, status, level, is_sample,
           created_at, photo_file,
           substr(description, 1, 50) AS description
    FROM reports
    ORDER BY id ASC
  `).all();

  console.log('Total reports:', reports.length);
  console.table(reports);
} finally {
  db.close();
}
