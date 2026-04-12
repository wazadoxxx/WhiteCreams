const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const db = require('./config/db');
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;
const defaultDatabaseDir = path.resolve(__dirname, '..', '..', 'database');
const configuredDatabaseDir = process.env.SQLITE_DB_DIR || defaultDatabaseDir;
const sqliteDbFileNameOrPath = process.env.SQLITE_DB_FILE || 'white_creams.sqlite';
const sqliteDbFilePath = path.isAbsolute(sqliteDbFileNameOrPath)
  ? sqliteDbFileNameOrPath
  : path.resolve(configuredDatabaseDir, sqliteDbFileNameOrPath);
const databaseDir = path.dirname(sqliteDbFilePath);
const sqliteDbFileName = path.basename(sqliteDbFilePath);
const backupsDir = path.resolve(databaseDir, 'backups');
const weeklyAutomationCheckIntervalMs = 60 * 1000;
const TEAM_HEIST_LIMIT_WINDOW_DAYS = 7;
const TEAM_HEIST_LIMIT_MAX = 2;
const TEAM_HEIST_LIMIT_WINDOW_MS = TEAM_HEIST_LIMIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const TEAM_HEIST_LIMIT_TYPES = ['Armurie', 'Fleeca Bank'];
const ARMURIE_WEAPONS = ['Lampe Torche', 'Club De Golf', 'Couteau', 'Pied de biche', 'Marteau'];
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function hasColumn(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

const hasLegacyHeistNameColumn = hasColumn('heists_history', 'heist_name');
const hasLegacyCityColumn = hasColumn('heists_history', 'city');
const hasHeistTypeColumn = hasColumn('heists_history', 'heist_type');
const hasMoneyTypeColumn = hasColumn('heists_history', 'money_type');
const hasParticipantsColumn = hasColumn('heists_history', 'participants');
const hasWeaponColumn = hasColumn('heists_history', 'weapon');

const heistTypeExpr = hasHeistTypeColumn
  ? (hasLegacyHeistNameColumn ? 'COALESCE(heist_type, heist_name)' : 'heist_type')
  : 'heist_name';
const moneyTypeExpr = hasMoneyTypeColumn ? "COALESCE(money_type, 'Sale')" : "'Sale'";
const participantsExpr = hasParticipantsColumn ? "COALESCE(participants, '[]')" : "'[]'";
const weaponExpr = hasWeaponColumn ? "COALESCE(weapon, '')" : "''";

function isTeamHeist(type) {
  return type === 'Armurie' || type === 'Fleeca Bank';
}

function getTeamHeistLimitWindowStartIso(nowDate = new Date()) {
  return new Date(nowDate.getTime() - TEAM_HEIST_LIMIT_WINDOW_MS).toISOString();
}

function computeTeamHeistLimitStatus(type, nowDate = new Date()) {
  const windowStartIso = getTeamHeistLimitWindowStartIso(nowDate);
  const rows = db
    .prepare(
      `SELECT heist_date
       FROM heists_history
       WHERE ${heistTypeExpr} = ?
         AND heist_date >= ?
       ORDER BY heist_date ASC, id ASC`
    )
    .all(type, windowStartIso);

  const countInWindow = rows.length;
  const remaining = Math.max(0, TEAM_HEIST_LIMIT_MAX - countInWindow);
  const activeSlots = countInWindow <= TEAM_HEIST_LIMIT_MAX ? rows : rows.slice(countInWindow - TEAM_HEIST_LIMIT_MAX);
  const slotCooldowns = Array.from({ length: TEAM_HEIST_LIMIT_MAX }).map((_, index) => {
    const row = activeSlots[index];
    if (!row) {
      return {
        slot: index + 1,
        startedAt: null,
        lockedUntil: null,
        isActive: false
      };
    }

    const startAtMs = Date.parse(row.heist_date);
    if (Number.isNaN(startAtMs)) {
      return {
        slot: index + 1,
        startedAt: null,
        lockedUntil: null,
        isActive: false
      };
    }

    const lockedUntilIso = new Date(startAtMs + TEAM_HEIST_LIMIT_WINDOW_MS).toISOString();
    return {
      slot: index + 1,
      startedAt: row.heist_date,
      lockedUntil: lockedUntilIso,
      isActive: Date.parse(lockedUntilIso) > nowDate.getTime()
    };
  });

  let lockedUntil = null;
  if (countInWindow >= TEAM_HEIST_LIMIT_MAX && activeSlots[0]) {
    const unlockFrom = Date.parse(activeSlots[0].heist_date);

    if (!Number.isNaN(unlockFrom)) {
      lockedUntil = new Date(unlockFrom + TEAM_HEIST_LIMIT_WINDOW_MS).toISOString();
    }
  }

  return {
    type,
    maxPerWindow: TEAM_HEIST_LIMIT_MAX,
    windowDays: TEAM_HEIST_LIMIT_WINDOW_DAYS,
    countInWindow,
    remaining,
    isLocked: remaining <= 0,
    lockedUntil,
    slotCooldowns
  };
}

function getAllTeamHeistLimitStatuses(nowDate = new Date()) {
  return TEAM_HEIST_LIMIT_TYPES.map((type) => computeTeamHeistLimitStatus(type, nowDate));
}

function sanitizeParticipants(input, currentPseudo) {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalizedPseudo = String(currentPseudo || '').trim().toLowerCase();
  const seen = new Set();

  return input
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)
    .filter((item) => item.toLowerCase() !== normalizedPseudo)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function parseParticipants(rawValue) {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function sanitizeTeamHeistWeapon(type, rawWeapon) {
  if (type !== 'Armurie') {
    return null;
  }

  const weapon = String(rawWeapon || '').trim();
  return ARMURIE_WEAPONS.includes(weapon) ? weapon : null;
}

function getUserByPseudo(pseudo) {
  return db
    .prepare(
      `SELECT users.id,
              users.pseudo,
              users.admin,
              users.grade,
              users.salary_percentage,
              users.group_share_percentage,
              grades.name AS grade_name
       FROM users
       LEFT JOIN grades ON grades.id = users.grade
       WHERE users.pseudo = ?
       LIMIT 1`
    )
    .get(pseudo);
}

function isAdminPseudo(pseudo) {
  const user = db.prepare('SELECT admin FROM users WHERE pseudo = ? LIMIT 1').get(pseudo);
  return Boolean(user && Number(user.admin) === 1);
}

function parseOptionalPercentage(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = typeof value === 'string'
    ? value.trim().replace(',', '.')
    : value;
  const parsedValue = Number(normalizedValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 100) {
    return NaN;
  }

  return parsedValue;
}

function normalizeStoredOptionalPercentage(value) {
  const parsedValue = parseOptionalPercentage(value);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function ensureBackupsDirectory() {
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
}

function getIsoWeekKey(dateValue = new Date()) {
  const date = new Date(Date.UTC(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return `${date.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function buildBackupFileName(scopeLabel) {
  const safeTimestamp = new Date().toISOString().replace(/[.:]/g, '-');
  return `backup-${scopeLabel}-${safeTimestamp}.sqlite`;
}

function buildReportFileName(sqliteFileName, extension) {
  return sqliteFileName.replace(/\.sqlite$/i, extension);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatReportMoney(value) {
  return `${new Intl.NumberFormat('fr-FR').format(Number(value || 0))} $`;
}

function formatReportPercent(value) {
  return `${Number(value || 0).toFixed(2)} %`;
}

function getBackupSnapshotData() {
  const totals = db
    .prepare(
      `SELECT
          (SELECT COUNT(*) FROM heists_history) AS total_heists,
          (SELECT COUNT(*) FROM drug_sales_history) AS total_drug_sales,
          COALESCE((SELECT SUM(gain) FROM heists_history), 0) + COALESCE((SELECT SUM(revenue) FROM drug_sales_history), 0) AS total_money_generated`
    )
    .get();

  const heistsByType = db
    .prepare(
      `SELECT ${heistTypeExpr} AS type,
              COUNT(*) AS total_count,
              COALESCE(SUM(gain), 0) AS total_gain
       FROM heists_history
       GROUP BY ${heistTypeExpr}
       ORDER BY total_count DESC, type ASC`
    )
    .all();

  const drugSalesByType = db
    .prepare(
      `SELECT drug_type,
              COUNT(*) AS total_sales,
              COALESCE(SUM(quantity), 0) AS total_quantity,
              COALESCE(SUM(revenue), 0) AS total_revenue
       FROM drug_sales_history
       GROUP BY drug_type
       ORDER BY total_sales DESC, drug_type ASC`
    )
    .all();

  const users = db
    .prepare(
      `SELECT u.pseudo,
              g.name AS grade_name,
              u.salary_percentage,
              u.group_share_percentage,
              COALESCE(h.heist_money, 0) AS total_heist_money,
              COALESCE(d.drug_money, 0) AS total_drug_money,
              COALESCE(h.heist_money, 0) + COALESCE(d.drug_money, 0) AS total_money_generated
       FROM users u
       LEFT JOIN grades g ON g.id = u.grade
       LEFT JOIN (
          SELECT user_id, COALESCE(SUM(gain), 0) AS heist_money
          FROM heists_history
          GROUP BY user_id
       ) h ON h.user_id = u.id
       LEFT JOIN (
          SELECT user_id, COALESCE(SUM(revenue), 0) AS drug_money
          FROM drug_sales_history
          GROUP BY user_id
       ) d ON d.user_id = u.id
       ORDER BY total_money_generated DESC, u.pseudo ASC`
    )
    .all();

  const usersWithSalary = users.map((item) => {
    const totalMoneyGenerated = Number(item.total_money_generated || 0);
    const salaryPercentage = item.salary_percentage == null ? null : Number(item.salary_percentage);
    const groupSharePercentage = item.group_share_percentage == null ? null : Number(item.group_share_percentage);
    const effectiveSalaryPercentage = salaryPercentage == null ? 35 : salaryPercentage;
    const totalPool = Number(totals.total_money_generated || 0);
    const autoSharePercentage = totalPool > 0 ? (totalMoneyGenerated / totalPool) * 100 : 0;
    const effectiveSharePercentage = groupSharePercentage == null ? autoSharePercentage : groupSharePercentage;
    const salary = totalMoneyGenerated * (effectiveSalaryPercentage / 100);

    return {
      pseudo: item.pseudo,
      gradeName: item.grade_name || null,
      salaryPercentage,
      groupSharePercentage,
      effectiveSalaryPercentage,
      effectiveSharePercentage,
      salary,
      totalHeistMoney: Number(item.total_heist_money || 0),
      totalDrugMoney: Number(item.total_drug_money || 0),
      totalMoneyGenerated
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalHeists: Number(totals.total_heists || 0),
      totalDrugSales: Number(totals.total_drug_sales || 0),
      totalMoneyGenerated: Number(totals.total_money_generated || 0)
    },
    heistsByType: heistsByType.map((item) => ({
      type: item.type,
      totalCount: Number(item.total_count || 0),
      totalGain: Number(item.total_gain || 0)
    })),
    drugSalesByType: drugSalesByType.map((item) => ({
      type: item.drug_type,
      totalSales: Number(item.total_sales || 0),
      totalQuantity: Number(item.total_quantity || 0),
      totalRevenue: Number(item.total_revenue || 0)
    })),
    users: usersWithSalary
  };
}

function buildBackupHtmlReport(snapshotData) {
  const heistsRows = snapshotData.heistsByType.length
    ? snapshotData.heistsByType
      .map((item) => `<tr><td>${escapeHtml(item.type)}</td><td>${item.totalCount}</td><td>${item.totalGain}</td></tr>`)
      .join('')
    : '<tr><td colspan="3">Aucune donnee</td></tr>';

  const drugsRows = snapshotData.drugSalesByType.length
    ? snapshotData.drugSalesByType
      .map((item) => `<tr><td>${escapeHtml(item.type)}</td><td>${item.totalSales}</td><td>${item.totalQuantity}</td><td>${item.totalRevenue}</td></tr>`)
      .join('')
    : '<tr><td colspan="4">Aucune donnee</td></tr>';

  const usersRows = snapshotData.users.length
    ? snapshotData.users
      .map((item) => `<tr><td>${escapeHtml(item.pseudo)}</td><td>${escapeHtml(item.gradeName || '-')}</td><td>${item.salaryPercentage == null ? '-' : formatReportPercent(item.salaryPercentage)}</td><td>${formatReportMoney(item.totalMoneyGenerated)}</td><td>${formatReportMoney(item.salary)}</td></tr>`)
      .join('')
    : '<tr><td colspan="5">Aucune donnee</td></tr>';

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rapport White Creams</title>
  <style>
    :root {
      --text: #eef4ff;
      --muted: #b7c4e6;
      --panel: rgba(13, 18, 37, 0.86);
      --panel-border: rgba(177, 195, 255, 0.32);
      --accent: #6ee7ff;
      --accent-2: #9cb1ff;
      --shadow: 0 22px 46px rgba(4, 8, 22, 0.5);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: 'Segoe UI', Tahoma, sans-serif;
      background: radial-gradient(circle at 20% 15%, #27406b 0%, #11172f 42%, #090d1e 100%);
    }

    .page-shell {
      width: min(1180px, calc(100% - 24px));
      margin: 18px auto 26px;
      display: grid;
      gap: 14px;
    }

    .title-row {
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 16px;
    }

    .kicker {
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 0.74rem;
      color: var(--accent);
      font-weight: 800;
    }

    h1 {
      margin: 8px 0 0;
      font-size: clamp(1.8rem, 4.5vw, 2.8rem);
      line-height: 1.05;
    }

    .muted {
      color: var(--muted);
      margin: 8px 0 0;
    }

    .stats-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .stat-card {
      border-radius: 18px;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px 20px;
    }

    .stat-label {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .stat-value {
      margin: 8px 0 0;
      font-size: clamp(1.45rem, 2.4vw, 2rem);
      font-weight: 800;
      color: #ffffff;
    }

    .table-card {
      border: 1px solid var(--panel-border);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: var(--shadow);
      background: var(--panel);
    }

    .section-head {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(177, 195, 255, 0.22);
    }

    h2 {
      margin: 0;
      font-size: 1.05rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead {
      background: rgba(7, 10, 24, 0.95);
    }

    th,
    td {
      text-align: left;
      padding: 14px 16px;
      vertical-align: top;
      border-bottom: 1px solid rgba(177, 195, 255, 0.15);
    }

    tbody tr:nth-child(odd) {
      background: rgba(19, 26, 54, 0.64);
    }

    tbody tr:nth-child(even) {
      background: rgba(13, 18, 37, 0.76);
    }

    @media (max-width: 920px) {
      .stats-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      .table-card {
        overflow-x: auto;
      }

      table {
        min-width: 640px;
      }
    }
  </style>
</head>
<body>
  <main class="page-shell">
    <section class="title-row">
      <p class="kicker">Sauvegarde Hebdomadaire</p>
      <h1>Rapport White Creams</h1>
      <p class="muted">Genere le ${escapeHtml(snapshotData.generatedAt)}</p>
    </section>

    <section class="stats-grid" aria-label="Totaux globaux">
      <article class="stat-card">
        <p class="stat-label">Total casses</p>
        <p class="stat-value">${snapshotData.totals.totalHeists}</p>
      </article>
      <article class="stat-card">
        <p class="stat-label">Total ventes drogues</p>
        <p class="stat-value">${snapshotData.totals.totalDrugSales}</p>
      </article>
      <article class="stat-card">
        <p class="stat-label">Argent total groupe</p>
        <p class="stat-value">${formatReportMoney(snapshotData.totals.totalMoneyGenerated)}</p>
      </article>
    </section>

    <section class="table-card" aria-label="Casses par type">
      <div class="section-head"><h2>Casses par type</h2></div>
      <table>
        <thead><tr><th>Type</th><th>Nombre</th><th>Gain total</th></tr></thead>
        <tbody>${heistsRows}</tbody>
      </table>
    </section>

    <section class="table-card" aria-label="Drogues par type">
      <div class="section-head"><h2>Drogues par type</h2></div>
      <table>
        <thead><tr><th>Type</th><th>Ventes</th><th>Quantite</th><th>Revenu</th></tr></thead>
        <tbody>${drugsRows}</tbody>
      </table>
    </section>

    <section class="table-card" aria-label="Resume par joueur">
      <div class="section-head"><h2>Resume par joueur</h2></div>
      <table>
        <thead><tr><th>Joueur</th><th>Grade</th><th>% Blanchissement</th><th>Argent apporte</th><th>Salaire</th></tr></thead>
        <tbody>${usersRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function getBackupList() {
  ensureBackupsDirectory();

  return fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry) => {
      const sqlitePath = path.resolve(backupsDir, entry.name);
      const sqliteStats = fs.statSync(sqlitePath);
      const reportFileName = buildReportFileName(entry.name, '.html');
      const jsonFileName = buildReportFileName(entry.name, '.json');
      const reportPath = path.resolve(backupsDir, reportFileName);
      const jsonPath = path.resolve(backupsDir, jsonFileName);

      return {
        fileName: entry.name,
        createdAt: sqliteStats.mtime.toISOString(),
        sizeBytes: sqliteStats.size,
        reportFileName: fs.existsSync(reportPath) ? reportFileName : null,
        jsonFileName: fs.existsSync(jsonPath) ? jsonFileName : null
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createDatabaseBackup(scopeLabel) {
  if (!fs.existsSync(sqliteDbFilePath)) {
    throw new Error('Base SQLite introuvable.');
  }

  ensureBackupsDirectory();

  const fileName = buildBackupFileName(scopeLabel);
  const targetPath = path.resolve(backupsDir, fileName);
  fs.copyFileSync(sqliteDbFilePath, targetPath);

  const snapshotData = getBackupSnapshotData();
  const reportFileName = buildReportFileName(fileName, '.html');
  const jsonFileName = buildReportFileName(fileName, '.json');
  const reportPath = path.resolve(backupsDir, reportFileName);
  const jsonPath = path.resolve(backupsDir, jsonFileName);

  fs.writeFileSync(reportPath, buildBackupHtmlReport(snapshotData), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(snapshotData, null, 2), 'utf8');

  const stats = fs.statSync(targetPath);
  return {
    fileName,
    createdAt: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    reportFileName,
    jsonFileName
  };
}

function resetAllActivityData() {
  const heistsDeleted = db
    .prepare(
      `DELETE FROM heists_history
       WHERE COALESCE(${heistTypeExpr}, '') NOT IN ('Armurie', 'Fleeca Bank')`
    )
    .run().changes;
  const drugSalesDeleted = db.prepare('DELETE FROM drug_sales_history').run().changes;

  db.prepare('INSERT OR IGNORE INTO player_stats (user_id) SELECT id FROM users').run();
  db.prepare('UPDATE player_stats SET total_money = 0, total_drugs_sold = 0, total_heists = 0').run();
  db.prepare(
    `UPDATE player_stats
     SET total_heists = COALESCE((SELECT COUNT(*) FROM heists_history h WHERE h.user_id = player_stats.user_id), 0),
         total_drugs_sold = COALESCE((SELECT SUM(quantity) FROM drug_sales_history d WHERE d.user_id = player_stats.user_id), 0),
         total_money = COALESCE((SELECT SUM(gain) FROM heists_history h WHERE h.user_id = player_stats.user_id), 0)
                     + COALESCE((SELECT SUM(revenue) FROM drug_sales_history d WHERE d.user_id = player_stats.user_id), 0)`
  ).run();

  return {
    heistsDeleted,
    drugSalesDeleted
  };
}

function isSundayAfterNineteen(dateValue = new Date()) {
  const day = dateValue.getDay();
  const hour = dateValue.getHours();
  return day === 0 && hour >= 19;
}

function hasWeeklyAutoResetBeenProcessed(weekKey) {
  const autoResetPrefix = `backup-auto-reset-${weekKey}-`;
  return getBackupList().some((item) => item.fileName.startsWith(autoResetPrefix));
}

function runWeeklyAutoResetIfDue() {
  const now = new Date();
  if (!isSundayAfterNineteen(now)) {
    return;
  }

  const weekKey = getIsoWeekKey(now);
  if (hasWeeklyAutoResetBeenProcessed(weekKey)) {
    return;
  }

  createDatabaseBackup(`auto-reset-${weekKey}`);
  const result = resetAllActivityData();
  console.log(
    `[AUTO RESET] Semaine ${weekKey} terminee - heists supprimes: ${result.heistsDeleted}, ventes drogues supprimees: ${result.drugSalesDeleted}`
  );
}

function startWeeklyAutomationScheduler() {
  try {
    runWeeklyAutoResetIfDue();
  } catch (error) {
    console.error('Echec automation hebdomadaire au demarrage:', error.message);
  }

  setInterval(() => {
    try {
      runWeeklyAutoResetIfDue();
    } catch (error) {
      console.error('Echec automation hebdomadaire:', error.message);
    }
  }, weeklyAutomationCheckIntervalMs);
}

function sanitizeBackupFileName(inputValue) {
  const fileName = String(inputValue || '');
  const safePattern = /^[a-zA-Z0-9._-]+\.(sqlite|html|json)$/;

  if (!safePattern.test(fileName)) {
    return null;
  }

  if (path.basename(fileName) !== fileName) {
    return null;
  }

  return fileName;
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// IMPORTANT: lien vers le frontend
app.use(express.static(path.join(__dirname, '../../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.use('/api', healthRoutes);

app.post('/api/auth/login', (req, res) => {
  const { pseudo, password } = req.body || {};

  if (!pseudo || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Pseudo et mot de passe requis.'
    });
  }

  try {
    const user = db
      .prepare(
        `SELECT users.id, users.pseudo, users.admin, users.grade, users.salary_percentage, grades.name AS grade_name
          , users.group_share_percentage
         FROM users
         LEFT JOIN grades ON grades.id = users.grade
         WHERE users.pseudo = ? AND users.password = ?
         LIMIT 1`
      )
      .get(pseudo, password);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Identifiants invalides.'
      });
    }

    return res.status(200).json({
      ok: true,
      token: 'demo-token-white-creams',
      user: {
        id: user.id,
        pseudo: user.pseudo,
        isAdmin: Number(user.admin) === 1,
        grade: user.grade,
        salaryPercentage: user.salary_percentage == null ? null : Number(user.salary_percentage),
        groupSharePercentage: user.group_share_percentage == null ? null : Number(user.group_share_percentage),
        gradeName: user.grade_name || null
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Erreur serveur pendant la connexion.'
    });
  }
});

app.get('/api/dashboard/:pseudo', (req, res) => {
  const pseudo = req.params.pseudo;

  try {
    const user = getUserByPseudo(pseudo);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'Utilisateur introuvable.'
      });
    }

    const stats = db
      .prepare(
        `SELECT total_money, total_drugs_sold, total_heists
         FROM player_stats
         WHERE user_id = ?
         LIMIT 1`
      )
      .get(user.id);

    const recentHeists = db
      .prepare(
        `SELECT ${heistTypeExpr} AS heist_type, ${moneyTypeExpr} AS money_type, gain, heist_date
         FROM heists_history
         WHERE user_id = ?
         ORDER BY heist_date DESC, id DESC
         LIMIT 3`
      )
      .all(user.id);

    return res.status(200).json({
      ok: true,
      user: {
        id: user.id,
        pseudo: user.pseudo,
        isAdmin: Number(user.admin) === 1,
        grade: user.grade,
        salaryPercentage: user.salary_percentage == null ? null : Number(user.salary_percentage),
        groupSharePercentage: user.group_share_percentage == null ? null : Number(user.group_share_percentage),
        gradeName: user.grade_name || null
      },
      summary: {
        totalMoney: stats ? stats.total_money : 0,
        totalDrugsSold: stats ? stats.total_drugs_sold : 0,
        totalHeists: stats ? stats.total_heists : 0
      },
      recentHeists: recentHeists.map((heist) => ({
        name: heist.heist_type,
        moneyType: heist.money_type,
        gain: heist.gain,
        date: heist.heist_date
      }))
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Erreur serveur pendant le chargement du dashboard.'
    });
  }
});

app.get('/api/casses/:pseudo', (req, res) => {
  const pseudo = req.params.pseudo;

  try {
    const user = getUserByPseudo(pseudo);

    if (!user) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(user.id);

    const heists = db
      .prepare(
        `SELECT id, ${heistTypeExpr} AS heist_type, ${moneyTypeExpr} AS money_type, ${participantsExpr} AS participants, ${weaponExpr} AS weapon, gain, heist_date
         FROM heists_history
         WHERE user_id = ?
         ORDER BY heist_date DESC, id DESC`
      )
      .all(user.id);

    const drugSales = db
      .prepare(
        `SELECT id, drug_type, quantity, revenue, sale_date
         FROM drug_sales_history
         WHERE user_id = ?
         ORDER BY sale_date DESC, id DESC`
      )
      .all(user.id);

    const activities = [
      ...heists.map((item) => ({
        id: `heist-${item.id}`,
        type: item.heist_type,
        moneyType: item.money_type || 'Sale',
        participants: parseParticipants(item.participants),
        weapon: item.weapon || null,
        gain: item.gain,
        date: item.heist_date,
        activityType: 'casse'
      })),
      ...drugSales.map((item) => ({
        id: `drug-${item.id}`,
        type: `Vente de drogues (${item.drug_type})`,
        drugType: item.drug_type,
        quantity: item.quantity,
        moneyType: 'Sale',
        gain: item.revenue,
        date: item.sale_date,
        activityType: 'drogue'
      }))
    ].sort((a, b) => {
      if (a.date === b.date) {
        return String(b.id).localeCompare(String(a.id));
      }
      return String(b.date).localeCompare(String(a.date));
    });

    return res.status(200).json({
      ok: true,
      user: {
        id: user.id,
        pseudo: user.pseudo,
        isAdmin: Number(user.admin) === 1,
        grade: user.grade,
        salaryPercentage: user.salary_percentage == null ? null : Number(user.salary_percentage),
        gradeName: user.grade_name || null
      },
      heists: activities
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des casses.' });
  }
});

app.get('/api/casses-options', (req, res) => {
  try {
    const heistTypes = db.prepare('SELECT name FROM heist_types ORDER BY name').all();
    const drugTypes = db.prepare('SELECT name FROM drug_types ORDER BY name').all();
    const users = db.prepare('SELECT pseudo FROM users ORDER BY pseudo').all();

    return res.status(200).json({
      ok: true,
      heistTypes: heistTypes.map((item) => item.name).filter((name) => !isTeamHeist(name)),
      drugTypes: drugTypes.map((item) => item.name),
      users: users.map((item) => item.pseudo)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des listes.' });
  }
});

app.post('/api/admin/:pseudo/drug-types', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const rawName = req.body?.name;
  const name = String(rawName || '').trim();

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!name) {
    return res.status(400).json({ ok: false, error: 'Nom de drogue requis.' });
  }

  try {
    const existing = db
      .prepare('SELECT name FROM drug_types WHERE LOWER(name) = LOWER(?) LIMIT 1')
      .get(name);

    if (existing) {
      return res.status(409).json({ ok: false, error: 'Ce type de drogue existe deja.' });
    }

    db.prepare('INSERT INTO drug_types (name) VALUES (?)').run(name);
    return res.status(201).json({ ok: true, drugType: { name } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant lajout de type de drogue.' });
  }
});

app.delete('/api/admin/:pseudo/drug-types/:name', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const name = String(req.params.name || '').trim();

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!name) {
    return res.status(400).json({ ok: false, error: 'Nom de drogue requis.' });
  }

  try {
    const existing = db
      .prepare('SELECT id, name FROM drug_types WHERE LOWER(name) = LOWER(?) LIMIT 1')
      .get(name);

    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Type de drogue introuvable.' });
    }

    const totalCount = db.prepare('SELECT COUNT(*) AS count FROM drug_types').get();
    if (Number(totalCount?.count || 0) <= 1) {
      return res.status(400).json({ ok: false, error: 'Impossible de supprimer le dernier type de drogue.' });
    }

    db.prepare('DELETE FROM drug_types WHERE id = ?').run(existing.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la suppression de type de drogue.' });
  }
});

app.get('/api/team-heists', (req, res) => {
  try {
    const limitsByType = getAllTeamHeistLimitStatuses();
    const heists = db
      .prepare(
        `SELECT h.id,
                u.pseudo,
                ${heistTypeExpr} AS heist_type,
                ${moneyTypeExpr} AS money_type,
                ${participantsExpr} AS participants,
                  ${weaponExpr} AS weapon,
                h.gain,
                h.heist_date
         FROM heists_history h
         JOIN users u ON u.id = h.user_id
         WHERE ${heistTypeExpr} IN ('Armurie', 'Fleeca Bank')
         ORDER BY h.heist_date DESC, h.id DESC`
      )
      .all();

    return res.status(200).json({
      ok: true,
      limits: {
        windowDays: TEAM_HEIST_LIMIT_WINDOW_DAYS,
        maxPerWindow: TEAM_HEIST_LIMIT_MAX,
        byType: limitsByType
      },
      heists: heists.map((item) => ({
        id: item.id,
        pseudo: item.pseudo,
        type: item.heist_type,
        moneyType: item.money_type || 'Sale',
        participants: parseParticipants(item.participants),
        weapon: item.weapon || null,
        gain: item.gain,
        date: item.heist_date
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des casses equipe.' });
  }
});

app.get('/api/payes-summary', (req, res) => {
  try {
    const heistsByType = db
      .prepare(
        `SELECT ${heistTypeExpr} AS type,
                COUNT(*) AS total_count,
                COALESCE(SUM(gain), 0) AS total_gain
         FROM heists_history
         GROUP BY ${heistTypeExpr}
         ORDER BY total_count DESC, type ASC`
      )
      .all();

    const drugSalesByType = db
      .prepare(
        `SELECT drug_type,
                COUNT(*) AS total_sales,
                COALESCE(SUM(quantity), 0) AS total_quantity,
                COALESCE(SUM(revenue), 0) AS total_revenue
         FROM drug_sales_history
         GROUP BY drug_type
         ORDER BY total_sales DESC, drug_type ASC`
      )
      .all();

    const users = db
      .prepare(
        `SELECT u.id,
                u.pseudo,
                u.admin,
                u.salary_percentage,
          u.group_share_percentage,
                g.name AS grade_name,
                COALESCE(h.heist_count, 0) AS total_heists,
                COALESCE(h.heist_money, 0) AS total_heist_money,
                COALESCE(d.drug_sales_count, 0) AS total_drug_sales,
                COALESCE(d.drug_money, 0) AS total_drug_money,
                COALESCE(h.heist_money, 0) + COALESCE(d.drug_money, 0) AS total_money_generated
         FROM users u
         LEFT JOIN grades g ON g.id = u.grade
         LEFT JOIN (
            SELECT user_id,
                   COUNT(*) AS heist_count,
                   COALESCE(SUM(gain), 0) AS heist_money
            FROM heists_history
            GROUP BY user_id
         ) h ON h.user_id = u.id
         LEFT JOIN (
            SELECT user_id,
                   COUNT(*) AS drug_sales_count,
                   COALESCE(SUM(revenue), 0) AS drug_money
            FROM drug_sales_history
            GROUP BY user_id
         ) d ON d.user_id = u.id
         ORDER BY total_money_generated DESC, u.pseudo ASC`
      )
      .all();

    const totalHeists = heistsByType.reduce((acc, item) => acc + Number(item.total_count || 0), 0);
    const totalDrugSales = drugSalesByType.reduce((acc, item) => acc + Number(item.total_sales || 0), 0);
    const totalMoneyGenerated = users.reduce((acc, item) => acc + Number(item.total_money_generated || 0), 0);

    return res.status(200).json({
      ok: true,
      totals: {
        totalHeists,
        totalDrugSales,
        totalMoneyGenerated
      },
      heistsByType: heistsByType.map((item) => ({
        type: item.type,
        totalCount: Number(item.total_count || 0),
        totalGain: Number(item.total_gain || 0)
      })),
      drugSalesByType: drugSalesByType.map((item) => ({
        type: item.drug_type,
        totalSales: Number(item.total_sales || 0),
        totalQuantity: Number(item.total_quantity || 0),
        totalRevenue: Number(item.total_revenue || 0)
      })),
      users: users.map((item) => ({
        id: item.id,
        pseudo: item.pseudo,
        isAdmin: Number(item.admin) === 1,
        salaryPercentage: normalizeStoredOptionalPercentage(item.salary_percentage),
        groupSharePercentage: normalizeStoredOptionalPercentage(item.group_share_percentage),
        gradeName: item.grade_name || null,
        totalHeists: Number(item.total_heists || 0),
        totalHeistMoney: Number(item.total_heist_money || 0),
        totalDrugSales: Number(item.total_drug_sales || 0),
        totalDrugMoney: Number(item.total_drug_money || 0),
        totalMoneyGenerated: Number(item.total_money_generated || 0)
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le calcul des payes.' });
  }
});

app.get('/api/admin/:pseudo/users-settings', (req, res) => {
  const adminPseudo = req.params.pseudo;

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  try {
    const grades = db.prepare('SELECT id, name FROM grades ORDER BY id').all();
    const users = db
      .prepare(
        `SELECT users.id,
                users.pseudo,
                users.admin,
                users.salary_percentage,
          users.group_share_percentage,
                users.grade,
                grades.name AS grade_name
         FROM users
         LEFT JOIN grades ON grades.id = users.grade
         ORDER BY users.pseudo ASC`
      )
      .all();

    return res.status(200).json({
      ok: true,
      grades: grades.map((item) => ({ id: item.id, name: item.name })),
      users: users.map((item) => ({
        id: item.id,
        pseudo: item.pseudo,
        isAdmin: Number(item.admin) === 1,
        grade: item.grade,
        gradeName: item.grade_name || null,
        salaryPercentage: normalizeStoredOptionalPercentage(item.salary_percentage),
        groupSharePercentage: normalizeStoredOptionalPercentage(item.group_share_percentage)
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement admin.' });
  }
});

app.post('/api/admin/:pseudo/users', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const { pseudo, password, grade, isAdmin, salaryPercentage, groupSharePercentage } = req.body || {};

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  const trimmedPseudo = String(pseudo || '').trim();
  const rawPassword = String(password || '');
  const parsedGrade = Number(grade);
  const parsedSalaryPercentage = parseOptionalPercentage(salaryPercentage);
  const parsedGroupSharePercentage = parseOptionalPercentage(groupSharePercentage);

  if (!trimmedPseudo) {
    return res.status(400).json({ ok: false, error: 'Pseudo requis.' });
  }

  if (trimmedPseudo.length < 3) {
    return res.status(400).json({ ok: false, error: 'Le pseudo doit contenir au moins 3 caracteres.' });
  }

  if (!rawPassword) {
    return res.status(400).json({ ok: false, error: 'Mot de passe requis.' });
  }

  if (rawPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'Le mot de passe doit contenir au moins 6 caracteres.' });
  }

  if (!Number.isFinite(parsedGrade) || parsedGrade <= 0) {
    return res.status(400).json({ ok: false, error: 'Grade invalide.' });
  }

  if (Number.isNaN(parsedSalaryPercentage)) {
    return res.status(400).json({ ok: false, error: 'Pourcentage salaire invalide (0-100).' });
  }

  if (Number.isNaN(parsedGroupSharePercentage)) {
    return res.status(400).json({ ok: false, error: 'Part du groupe invalide (0-100).' });
  }

  try {
    const gradeExists = db.prepare('SELECT id FROM grades WHERE id = ? LIMIT 1').get(parsedGrade);
    if (!gradeExists) {
      return res.status(400).json({ ok: false, error: 'Grade introuvable.' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE pseudo = ? LIMIT 1').get(trimmedPseudo);
    if (existingUser) {
      return res.status(409).json({ ok: false, error: 'Ce pseudo existe deja.' });
    }

    const insertResult = db
      .prepare(
        `INSERT INTO users (pseudo, password, admin, salary_percentage, group_share_percentage, grade)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        trimmedPseudo,
        rawPassword,
        isAdmin ? 1 : 0,
        parsedSalaryPercentage,
        parsedGroupSharePercentage,
        parsedGrade
      );

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(insertResult.lastInsertRowid);

    return res.status(201).json({
      ok: true,
      user: {
        id: Number(insertResult.lastInsertRowid),
        pseudo: trimmedPseudo,
        isAdmin: Boolean(isAdmin),
        grade: parsedGrade,
        salaryPercentage: parsedSalaryPercentage,
        groupSharePercentage: parsedGroupSharePercentage
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la creation utilisateur.' });
  }
});

app.put('/api/admin/:pseudo/users/:id/settings', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const targetUserId = Number(req.params.id);
  const { grade, salaryPercentage, groupSharePercentage } = req.body || {};

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: 'Identifiant utilisateur invalide.' });
  }

  const parsedGrade = Number(grade);
  if (!Number.isFinite(parsedGrade) || parsedGrade <= 0) {
    return res.status(400).json({ ok: false, error: 'Grade invalide.' });
  }

  const parsedPercentage = parseOptionalPercentage(salaryPercentage);
  if (Number.isNaN(parsedPercentage)) {
    return res.status(400).json({ ok: false, error: 'Pourcentage salaire invalide (0-100).' });
  }

  const parsedGroupSharePercentage = parseOptionalPercentage(groupSharePercentage);
  if (Number.isNaN(parsedGroupSharePercentage)) {
    return res.status(400).json({ ok: false, error: 'Part du groupe invalide (0-100).' });
  }

  try {
    const gradeExists = db.prepare('SELECT id FROM grades WHERE id = ? LIMIT 1').get(parsedGrade);
    if (!gradeExists) {
      return res.status(400).json({ ok: false, error: 'Grade introuvable.' });
    }

    const userExists = db.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').get(targetUserId);
    if (!userExists) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    db
      .prepare('UPDATE users SET grade = ?, salary_percentage = ?, group_share_percentage = ? WHERE id = ?')
      .run(parsedGrade, parsedPercentage, parsedGroupSharePercentage, targetUserId);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la mise a jour admin.' });
  }
});

app.delete('/api/admin/:pseudo/users/:id', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const targetUserId = Number(req.params.id);

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: 'Identifiant utilisateur invalide.' });
  }

  try {
    const targetUser = db.prepare('SELECT id, pseudo, admin FROM users WHERE id = ? LIMIT 1').get(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    if (targetUser.pseudo === adminPseudo) {
      return res.status(400).json({ ok: false, error: 'Tu ne peux pas supprimer ton propre compte admin.' });
    }

    if (Number(targetUser.admin) === 1) {
      const adminCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE admin = 1').get();
      if (Number(adminCount?.count || 0) <= 1) {
        return res.status(400).json({ ok: false, error: 'Impossible de supprimer le dernier administrateur.' });
      }
    }

    const heistsDeleted = db.prepare('DELETE FROM heists_history WHERE user_id = ?').run(targetUserId).changes;
    const drugSalesDeleted = db.prepare('DELETE FROM drug_sales_history WHERE user_id = ?').run(targetUserId).changes;
    db.prepare('DELETE FROM player_stats WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

    return res.status(200).json({
      ok: true,
      deletedUser: targetUser.pseudo,
      heistsDeleted,
      drugSalesDeleted
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la suppression utilisateur.' });
  }
});

app.post('/api/admin/:pseudo/users/:id/reset-activity', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const targetUserId = Number(req.params.id);

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: 'Identifiant utilisateur invalide.' });
  }

  try {
    const userExists = db.prepare('SELECT id, pseudo FROM users WHERE id = ? LIMIT 1').get(targetUserId);
    if (!userExists) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    const heistsDeleted = db.prepare('DELETE FROM heists_history WHERE user_id = ?').run(targetUserId).changes;
    const drugSalesDeleted = db.prepare('DELETE FROM drug_sales_history WHERE user_id = ?').run(targetUserId).changes;

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(targetUserId);
    db.prepare(
      `UPDATE player_stats
       SET total_money = 0,
           total_drugs_sold = 0,
           total_heists = 0
       WHERE user_id = ?`
    ).run(targetUserId);

    return res.status(200).json({
      ok: true,
      resetUser: userExists.pseudo,
      heistsDeleted,
      drugSalesDeleted
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la remise a zero des activites.' });
  }
});

app.post('/api/admin/:pseudo/reset-all-activity', (req, res) => {
  const adminPseudo = req.params.pseudo;

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  try {
    const result = resetAllActivityData();

    return res.status(200).json({
      ok: true,
      heistsDeleted: result.heistsDeleted,
      drugSalesDeleted: result.drugSalesDeleted
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la remise a zero globale.' });
  }
});

app.get('/api/admin/:pseudo/backups', (req, res) => {
  const adminPseudo = req.params.pseudo;

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  try {
    return res.status(200).json({
      ok: true,
      backups: getBackupList()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des sauvegardes.' });
  }
});

app.post('/api/admin/:pseudo/backups', (req, res) => {
  const adminPseudo = req.params.pseudo;

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  try {
    const backup = createDatabaseBackup('manual');
    return res.status(201).json({ ok: true, backup });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la creation de la sauvegarde.' });
  }
});

app.get('/api/admin/:pseudo/backups/:fileName', (req, res) => {
  const adminPseudo = req.params.pseudo;
  const safeFileName = sanitizeBackupFileName(req.params.fileName);

  if (!isAdminPseudo(adminPseudo)) {
    return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
  }

  if (!safeFileName) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide.' });
  }

  const backupPath = path.resolve(backupsDir, safeFileName);

  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ ok: false, error: 'Sauvegarde introuvable.' });
  }

  return res.download(backupPath, safeFileName);
});

app.post('/api/casses/:pseudo/heists', (req, res) => {
  const pseudo = req.params.pseudo;
  const { type, gain, date, participants, weapon } = req.body || {};
  const safeDate = date || new Date().toISOString();

  if (!type) {
    return res.status(400).json({ ok: false, error: 'Type de casse requis.' });
  }

  const parsedGain = Number(gain || 0);
  if (!Number.isFinite(parsedGain) || parsedGain < 0) {
    return res.status(400).json({ ok: false, error: 'Gain invalide.' });
  }

  const cleanedParticipants = sanitizeParticipants(participants, pseudo);
  if (isTeamHeist(type) && cleanedParticipants.length === 0) {
    return res.status(400).json({ ok: false, error: 'Pour Armurie/Fleeca, ajoute au moins 1 participant.' });
  }

  const safeWeapon = sanitizeTeamHeistWeapon(type, weapon);
  if (type === 'Armurie' && !safeWeapon) {
    return res.status(400).json({ ok: false, error: 'Pour Armurie, selectionne une arme valide.' });
  }

  const participantsJson = JSON.stringify(cleanedParticipants);

  try {
    if (isTeamHeist(type)) {
      const teamLimitStatus = computeTeamHeistLimitStatus(type);
      if (teamLimitStatus.isLocked) {
        const unlockLabel = teamLimitStatus.lockedUntil
          ? new Date(teamLimitStatus.lockedUntil).toLocaleString('fr-FR')
          : 'dans 7 jours';

        return res.status(429).json({
          ok: false,
          error: `${type} limite a ${TEAM_HEIST_LIMIT_MAX} sur ${TEAM_HEIST_LIMIT_WINDOW_DAYS} jours. Reessayez le ${unlockLabel}.`,
          limit: teamLimitStatus
        });
      }
    }

    const user = db.prepare('SELECT id FROM users WHERE pseudo = ? LIMIT 1').get(pseudo);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(user.id);

    const heistTypeConfig = db
      .prepare('SELECT money_type FROM heist_types WHERE name = ? LIMIT 1')
      .get(type);
    const moneyType = heistTypeConfig ? heistTypeConfig.money_type : (type === 'Cambriolage' ? 'Propre' : 'Sale');

    if (hasLegacyHeistNameColumn && hasLegacyCityColumn) {
      if (hasParticipantsColumn) {
        if (hasWeaponColumn) {
          db.prepare(
            `INSERT INTO heists_history (user_id, heist_name, city, heist_type, money_type, participants, weapon, gain, heist_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(user.id, type, 'Inconnue', type, moneyType, participantsJson, safeWeapon, parsedGain, safeDate);
        } else {
          db.prepare(
            `INSERT INTO heists_history (user_id, heist_name, city, heist_type, money_type, participants, gain, heist_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(user.id, type, 'Inconnue', type, moneyType, participantsJson, parsedGain, safeDate);
        }
      } else {
        if (hasWeaponColumn) {
          db.prepare(
            `INSERT INTO heists_history (user_id, heist_name, city, heist_type, money_type, weapon, gain, heist_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(user.id, type, 'Inconnue', type, moneyType, safeWeapon, parsedGain, safeDate);
        } else {
          db.prepare(
            `INSERT INTO heists_history (user_id, heist_name, city, heist_type, money_type, gain, heist_date)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(user.id, type, 'Inconnue', type, moneyType, parsedGain, safeDate);
        }
      }
    } else if (hasMoneyTypeColumn) {
      if (hasParticipantsColumn) {
        if (hasWeaponColumn) {
          db.prepare(
            'INSERT INTO heists_history (user_id, heist_type, money_type, participants, weapon, gain, heist_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(user.id, type, moneyType, participantsJson, safeWeapon, parsedGain, safeDate);
        } else {
          db.prepare(
            'INSERT INTO heists_history (user_id, heist_type, money_type, participants, gain, heist_date) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(user.id, type, moneyType, participantsJson, parsedGain, safeDate);
        }
      } else {
        if (hasWeaponColumn) {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, money_type, weapon, gain, heist_date) VALUES (?, ?, ?, ?, ?, ?)').run(
            user.id,
            type,
            moneyType,
            safeWeapon,
            parsedGain,
            safeDate
          );
        } else {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, money_type, gain, heist_date) VALUES (?, ?, ?, ?, ?)').run(
            user.id,
            type,
            moneyType,
            parsedGain,
            safeDate
          );
        }
      }
    } else {
      if (hasParticipantsColumn) {
        if (hasWeaponColumn) {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, participants, weapon, gain, heist_date) VALUES (?, ?, ?, ?, ?, ?)').run(
            user.id,
            type,
            participantsJson,
            safeWeapon,
            parsedGain,
            safeDate
          );
        } else {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, participants, gain, heist_date) VALUES (?, ?, ?, ?, ?)').run(
            user.id,
            type,
            participantsJson,
            parsedGain,
            safeDate
          );
        }
      } else {
        if (hasWeaponColumn) {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, weapon, gain, heist_date) VALUES (?, ?, ?, ?, ?)').run(
            user.id,
            type,
            safeWeapon,
            parsedGain,
            safeDate
          );
        } else {
          db.prepare('INSERT INTO heists_history (user_id, heist_type, gain, heist_date) VALUES (?, ?, ?, ?)').run(
            user.id,
            type,
            parsedGain,
            safeDate
          );
        }
      }
    }

    db.prepare(
      `UPDATE player_stats
       SET total_heists = total_heists + 1,
           total_money = total_money + ?
       WHERE user_id = ?`
    ).run(parsedGain, user.id);

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant lajout de casse.' });
  }
});

app.put('/api/casses/:pseudo/heists/:id', (req, res) => {
  const pseudo = req.params.pseudo;
  const heistId = Number(req.params.id);
  const { type, gain, participants, weapon } = req.body || {};

  if (!Number.isFinite(heistId) || heistId <= 0) {
    return res.status(400).json({ ok: false, error: 'Identifiant de casse invalide.' });
  }

  if (!type) {
    return res.status(400).json({ ok: false, error: 'Type de casse requis.' });
  }

  const parsedGain = Number(gain || 0);
  if (!Number.isFinite(parsedGain) || parsedGain < 0) {
    return res.status(400).json({ ok: false, error: 'Gain invalide.' });
  }

  const cleanedParticipants = sanitizeParticipants(participants, pseudo);
  if (isTeamHeist(type) && cleanedParticipants.length === 0) {
    return res.status(400).json({ ok: false, error: 'Pour Armurie/Fleeca, ajoute au moins 1 participant.' });
  }

  const safeWeapon = sanitizeTeamHeistWeapon(type, weapon);
  if (type === 'Armurie' && !safeWeapon) {
    return res.status(400).json({ ok: false, error: 'Pour Armurie, selectionne une arme valide.' });
  }

  const participantsJson = JSON.stringify(cleanedParticipants);

  try {
    const user = db.prepare('SELECT id FROM users WHERE pseudo = ? LIMIT 1').get(pseudo);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    const existing = db
      .prepare('SELECT id, gain FROM heists_history WHERE id = ? AND user_id = ? LIMIT 1')
      .get(heistId, user.id);

    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Casse introuvable.' });
    }

    const heistTypeConfig = db
      .prepare('SELECT money_type FROM heist_types WHERE name = ? LIMIT 1')
      .get(type);
    const moneyType = heistTypeConfig ? heistTypeConfig.money_type : (type === 'Cambriolage' ? 'Propre' : 'Sale');

    if (hasLegacyHeistNameColumn && hasLegacyCityColumn) {
      if (hasParticipantsColumn) {
        if (hasWeaponColumn) {
          db.prepare(
            `UPDATE heists_history
             SET heist_name = ?,
                 heist_type = ?,
                 money_type = ?,
                 participants = ?,
                 weapon = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, type, moneyType, participantsJson, safeWeapon, parsedGain, heistId, user.id);
        } else {
          db.prepare(
            `UPDATE heists_history
             SET heist_name = ?,
                 heist_type = ?,
                 money_type = ?,
                 participants = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, type, moneyType, participantsJson, parsedGain, heistId, user.id);
        }
      } else {
        if (hasWeaponColumn) {
          db.prepare(
            `UPDATE heists_history
             SET heist_name = ?,
                 heist_type = ?,
                 money_type = ?,
                 weapon = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, type, moneyType, safeWeapon, parsedGain, heistId, user.id);
        } else {
          db.prepare(
            `UPDATE heists_history
             SET heist_name = ?,
                 heist_type = ?,
                 money_type = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, type, moneyType, parsedGain, heistId, user.id);
        }
      }
    } else {
      if (hasParticipantsColumn) {
        if (hasWeaponColumn) {
          db.prepare(
            `UPDATE heists_history
             SET heist_type = ?,
                 money_type = ?,
                 participants = ?,
                 weapon = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, moneyType, participantsJson, safeWeapon, parsedGain, heistId, user.id);
        } else {
          db.prepare(
            `UPDATE heists_history
             SET heist_type = ?,
                 money_type = ?,
                 participants = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, moneyType, participantsJson, parsedGain, heistId, user.id);
        }
      } else {
        if (hasWeaponColumn) {
          db.prepare(
            `UPDATE heists_history
             SET heist_type = ?,
                 money_type = ?,
                 weapon = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, moneyType, safeWeapon, parsedGain, heistId, user.id);
        } else {
          db.prepare(
            `UPDATE heists_history
             SET heist_type = ?,
                 money_type = ?,
                 gain = ?
             WHERE id = ? AND user_id = ?`
          ).run(type, moneyType, parsedGain, heistId, user.id);
        }
      }
    }

    const delta = parsedGain - Number(existing.gain || 0);
    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(user.id);
    db.prepare('UPDATE player_stats SET total_money = total_money + ? WHERE user_id = ?').run(delta, user.id);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la modification de casse.' });
  }
});

app.post('/api/casses/:pseudo/drug-sales', (req, res) => {
  const pseudo = req.params.pseudo;
  const { type, quantity, revenue, date } = req.body || {};
  const safeDate = date || new Date().toISOString();
  const safeType = type || 'Inconnue';

  const parsedQuantity = Number(quantity || 0);
  const parsedRevenue = Number(revenue || 0);

  if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
    return res.status(400).json({ ok: false, error: 'Quantite invalide.' });
  }

  if (!Number.isFinite(parsedRevenue) || parsedRevenue < 0) {
    return res.status(400).json({ ok: false, error: 'Montant invalide.' });
  }

  try {
    const user = db.prepare('SELECT id FROM users WHERE pseudo = ? LIMIT 1').get(pseudo);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(user.id);

    db.prepare('INSERT INTO drug_sales_history (user_id, drug_type, quantity, revenue, sale_date) VALUES (?, ?, ?, ?, ?)').run(
      user.id,
      safeType,
      parsedQuantity,
      parsedRevenue,
      safeDate
    );

    db.prepare(
      `UPDATE player_stats
       SET total_drugs_sold = total_drugs_sold + ?,
           total_money = total_money + ?
       WHERE user_id = ?`
    ).run(parsedQuantity, parsedRevenue, user.id);

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant lajout de vente de drogues.' });
  }
});

app.put('/api/casses/:pseudo/drug-sales/:id', (req, res) => {
  const pseudo = req.params.pseudo;
  const saleId = Number(req.params.id);
  const { type, quantity, revenue } = req.body || {};
  const safeType = type || 'Inconnue';

  if (!Number.isFinite(saleId) || saleId <= 0) {
    return res.status(400).json({ ok: false, error: 'Identifiant de vente invalide.' });
  }

  const parsedQuantity = Number(quantity || 0);
  const parsedRevenue = Number(revenue || 0);

  if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
    return res.status(400).json({ ok: false, error: 'Quantite invalide.' });
  }

  if (!Number.isFinite(parsedRevenue) || parsedRevenue < 0) {
    return res.status(400).json({ ok: false, error: 'Montant invalide.' });
  }

  try {
    const user = db.prepare('SELECT id FROM users WHERE pseudo = ? LIMIT 1').get(pseudo);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
    }

    const existing = db
      .prepare('SELECT id, quantity, revenue FROM drug_sales_history WHERE id = ? AND user_id = ? LIMIT 1')
      .get(saleId, user.id);

    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Vente de drogues introuvable.' });
    }

    db.prepare(
      `UPDATE drug_sales_history
       SET drug_type = ?,
           quantity = ?,
           revenue = ?
       WHERE id = ? AND user_id = ?`
    ).run(safeType, parsedQuantity, parsedRevenue, saleId, user.id);

    db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').run(user.id);

    const moneyDelta = parsedRevenue - Number(existing.revenue || 0);
    const quantityDelta = parsedQuantity - Number(existing.quantity || 0);

    db.prepare(
      `UPDATE player_stats
       SET total_money = total_money + ?,
           total_drugs_sold = total_drugs_sold + ?
       WHERE user_id = ?`
    ).run(moneyDelta, quantityDelta, user.id);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la modification de vente de drogues.' });
  }
});

app.get('/api/db-check', (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) AS totalUsers FROM users').get();
    return res.status(200).json({
      ok: true,
      database: 'sqlite',
      sqliteFilePath: sqliteDbFilePath,
      totalUsers: result.totalUsers
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Database connection failed',
      details: error.message
    });
  }
});

startWeeklyAutomationScheduler();

app.listen(PORT, () => {
  console.log('Serveur lance sur ' + PORT);
});
