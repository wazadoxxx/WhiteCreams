const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

dotenv.config();

const defaultDatabaseDir = path.resolve(__dirname, '..', '..', '..', 'database');
const configuredDatabaseDir = process.env.SQLITE_DB_DIR || defaultDatabaseDir;
const sqliteDbFileNameOrPath = process.env.SQLITE_DB_FILE || 'white_creams.sqlite';
const dbFilePath = path.isAbsolute(sqliteDbFileNameOrPath)
  ? sqliteDbFileNameOrPath
  : path.resolve(configuredDatabaseDir, sqliteDbFileNameOrPath);

const initSqlPath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'database',
  'init',
  '001_schema.sql'
);

fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

const db = new Database(dbFilePath);

function tableExists(tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  return Boolean(row);
}

function hasColumn(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

if (!tableExists('grades')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);
}

db.prepare(
  `
    INSERT OR IGNORE INTO grades (name) VALUES
      ('Leader'),
      ('Co-Leader'),
      ('Officier'),
      ('Membre Confirmé'),
      ('Membre')
  `
).run();

if (tableExists('users') && !hasColumn('users', 'grade')) {
  db.exec('ALTER TABLE users ADD COLUMN grade INTEGER');
}

if (tableExists('users') && !hasColumn('users', 'admin')) {
  db.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
}

if (tableExists('users') && !hasColumn('users', 'salary_percentage')) {
  db.exec('ALTER TABLE users ADD COLUMN salary_percentage REAL');
}

if (tableExists('users') && !hasColumn('users', 'group_share_percentage')) {
  db.exec('ALTER TABLE users ADD COLUMN group_share_percentage REAL');
}

if (tableExists('users')) {
  db.exec('UPDATE users SET grade = 5 WHERE grade IS NULL');
  db.exec('UPDATE users SET admin = 0 WHERE admin IS NULL');
  db.exec("UPDATE users SET salary_percentage = NULL WHERE TRIM(CAST(salary_percentage AS TEXT)) = ''");
  db.exec("UPDATE users SET group_share_percentage = NULL WHERE TRIM(CAST(group_share_percentage AS TEXT)) = ''");
}

// Keep backward compatibility if a previous DB version still uses heist_name.
if (tableExists('heists_history') && !hasColumn('heists_history', 'heist_type')) {
  db.exec("ALTER TABLE heists_history ADD COLUMN heist_type TEXT");

  if (hasColumn('heists_history', 'heist_name')) {
    db.exec("UPDATE heists_history SET heist_type = heist_name WHERE heist_type IS NULL OR heist_type = ''");
  } else {
    db.exec("UPDATE heists_history SET heist_type = 'Inconnu' WHERE heist_type IS NULL OR heist_type = ''");
  }
}

if (tableExists('drug_sales_history') && !hasColumn('drug_sales_history', 'drug_type')) {
  db.exec("ALTER TABLE drug_sales_history ADD COLUMN drug_type TEXT");
  db.exec("UPDATE drug_sales_history SET drug_type = 'Inconnue' WHERE drug_type IS NULL OR drug_type = ''");
}

if (tableExists('heist_types') && !hasColumn('heist_types', 'money_type')) {
  db.exec("ALTER TABLE heist_types ADD COLUMN money_type TEXT");
  db.exec("UPDATE heist_types SET money_type = 'Sale' WHERE money_type IS NULL OR money_type = ''");
  db.exec("UPDATE heist_types SET money_type = 'Propre' WHERE name = 'Cambriolage'");
}

if (tableExists('heists_history') && !hasColumn('heists_history', 'money_type')) {
  db.exec("ALTER TABLE heists_history ADD COLUMN money_type TEXT");
  db.exec("UPDATE heists_history SET money_type = 'Sale' WHERE money_type IS NULL OR money_type = ''");
  db.exec("UPDATE heists_history SET money_type = 'Propre' WHERE heist_type = 'Cambriolage'");
}

if (tableExists('heists_history') && !hasColumn('heists_history', 'participants')) {
  db.exec('ALTER TABLE heists_history ADD COLUMN participants TEXT');
  db.exec("UPDATE heists_history SET participants = '[]' WHERE participants IS NULL OR participants = ''");
}

if (tableExists('heists_history') && !hasColumn('heists_history', 'weapon')) {
  db.exec('ALTER TABLE heists_history ADD COLUMN weapon TEXT');
}

if (fs.existsSync(initSqlPath)) {
  const initSql = fs.readFileSync(initSqlPath, 'utf8');

  try {
    db.exec(initSql);
  } catch (error) {
    // Retry once after migration in case schema changed between versions.
    if (tableExists('heists_history') && !hasColumn('heists_history', 'heist_type')) {
      db.exec("ALTER TABLE heists_history ADD COLUMN heist_type TEXT");
      db.exec("UPDATE heists_history SET heist_type = 'Inconnu' WHERE heist_type IS NULL OR heist_type = ''");
      db.exec(initSql);
    } else {
      throw error;
    }
  }
}

module.exports = db;
