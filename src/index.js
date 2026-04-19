const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const database = require('./config/db');
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;
const pgPool = database.pgPool;
const hasConfiguredSupabase = Boolean(database.hasConfiguredSupabase);
const projectRoot = path.resolve(__dirname, '..', '..');
const backupsDir = path.resolve(projectRoot, 'database', 'backups');
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

function requirePool() {
    if (!pgPool) {
        throw new Error('Connexion Supabase non configuree.');
    }

    return pgPool;
}

async function query(text, params = []) {
    return requirePool().query(text, params);
}

async function queryRows(text, params = [], executor = requirePool()) {
    const result = await executor.query(text, params);
    return result.rows;
}

async function queryOne(text, params = [], executor = requirePool()) {
    const rows = await queryRows(text, params, executor);
    return rows[0] || null;
}

async function withTransaction(callback) {
    const pool = requirePool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function isTeamHeist(type) {
    return type === 'Armurie' || type === 'Fleeca Bank';
}

function getTeamHeistLimitWindowStartIso(nowDate = new Date()) {
    return new Date(nowDate.getTime() - TEAM_HEIST_LIMIT_WINDOW_MS).toISOString();
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

    if (Array.isArray(rawValue)) {
        return rawValue;
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

function formatUserPayload(row) {
    return {
        id: Number(row.id),
        pseudo: row.pseudo,
        isAdmin: Boolean(row.admin),
        grade: row.grade == null ? null : Number(row.grade),
        salaryPercentage: normalizeStoredOptionalPercentage(row.salary_percentage),
        groupSharePercentage: normalizeStoredOptionalPercentage(row.group_share_percentage),
        gradeName: row.grade_name || null
    };
}

async function getUserByPseudo(pseudo, executor = requirePool()) {
    return queryOne(
        `SELECT users.id,
            users.pseudo,
            users.admin,
            users.grade,
            users.salary_percentage,
            users.group_share_percentage,
            grades.name AS grade_name
     FROM users
     LEFT JOIN grades ON grades.id = users.grade
     WHERE users.pseudo = $1
     LIMIT 1`,
        [pseudo],
        executor
    );
}

async function isAdminPseudo(pseudo, executor = requirePool()) {
    const user = await queryOne('SELECT admin FROM users WHERE pseudo = $1 LIMIT 1', [pseudo], executor);
    return Boolean(user && user.admin);
}

async function ensurePlayerStatsRow(userId, executor = requirePool()) {
    await executor.query(
        'INSERT INTO player_stats (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [userId]
    );
}

async function syncPlayerRecord(userId, executor = requirePool()) {
    await executor.query(
        `INSERT INTO players (name, total_money)
     SELECT u.pseudo,
            COALESCE(ps.total_money, 0)
     FROM users u
     LEFT JOIN player_stats ps ON ps.user_id = u.id
     WHERE u.id = $1
     ON CONFLICT (name) DO UPDATE SET total_money = EXCLUDED.total_money`,
        [userId]
    );
}

async function syncAllPlayers(executor = requirePool()) {
    await executor.query(
        `INSERT INTO players (name, total_money)
     SELECT u.pseudo,
            COALESCE(ps.total_money, 0)
     FROM users u
     LEFT JOIN player_stats ps ON ps.user_id = u.id
     ON CONFLICT (name) DO UPDATE SET total_money = EXCLUDED.total_money`
    );

    await executor.query(
        `DELETE FROM players p
     WHERE NOT EXISTS (
       SELECT 1
       FROM users u
       WHERE u.pseudo = p.name
     )`
    );
}

async function recomputePlayerStats(userId, executor = requirePool()) {
    await ensurePlayerStatsRow(userId, executor);

    await executor.query(
        `UPDATE player_stats
     SET total_heists = COALESCE((SELECT COUNT(*) FROM heists_history WHERE user_id = $1), 0),
         total_drugs_sold = COALESCE((SELECT SUM(quantity) FROM drug_sales_history WHERE user_id = $1), 0),
         total_money = COALESCE((SELECT SUM(gain) FROM heists_history WHERE user_id = $1), 0)
                     + COALESCE((SELECT SUM(revenue) FROM drug_sales_history WHERE user_id = $1), 0)
     WHERE user_id = $1`,
        [userId]
    );

    await syncPlayerRecord(userId, executor);
}

async function recomputeAllPlayerStats(executor = requirePool()) {
    await executor.query(
        `INSERT INTO player_stats (user_id)
     SELECT id FROM users
     ON CONFLICT (user_id) DO NOTHING`
    );

    await executor.query(
        `UPDATE player_stats ps
     SET total_heists = COALESCE(h.total_heists, 0),
         total_drugs_sold = COALESCE(d.total_drugs_sold, 0),
         total_money = COALESCE(h.total_money, 0) + COALESCE(d.total_money, 0)
     FROM users u
     LEFT JOIN (
       SELECT user_id,
              COUNT(*) AS total_heists,
              COALESCE(SUM(gain), 0) AS total_money
       FROM heists_history
       GROUP BY user_id
     ) h ON h.user_id = u.id
     LEFT JOIN (
       SELECT user_id,
              COALESCE(SUM(quantity), 0) AS total_drugs_sold,
              COALESCE(SUM(revenue), 0) AS total_money
       FROM drug_sales_history
       GROUP BY user_id
     ) d ON d.user_id = u.id
     WHERE ps.user_id = u.id`
    );

    await syncAllPlayers(executor);
}

async function getHeistMoneyType(type, executor = requirePool()) {
    const row = await queryOne(
        'SELECT money_type FROM heist_types WHERE name = $1 LIMIT 1',
        [type],
        executor
    );

    return row ? row.money_type : (type === 'Cambriolage' ? 'Propre' : 'Sale');
}

async function computeTeamHeistLimitStatus(type, nowDate = new Date(), executor = requirePool()) {
    const windowStartIso = getTeamHeistLimitWindowStartIso(nowDate);
    const rows = await queryRows(
        `SELECT heist_date
     FROM heists_history
     WHERE heist_type = $1
       AND heist_date >= $2
     ORDER BY heist_date ASC, id ASC`,
        [type, windowStartIso],
        executor
    );

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

async function getAllTeamHeistLimitStatuses(nowDate = new Date(), executor = requirePool()) {
    return Promise.all(TEAM_HEIST_LIMIT_TYPES.map((type) => computeTeamHeistLimitStatus(type, nowDate, executor)));
}

async function getBackupSnapshotData(executor = requirePool()) {
    const totals = await queryOne(
        `SELECT
        (SELECT COUNT(*) FROM heists_history) AS total_heists,
        (SELECT COUNT(*) FROM drug_sales_history) AS total_drug_sales,
        COALESCE((SELECT SUM(gain) FROM heists_history), 0) + COALESCE((SELECT SUM(revenue) FROM drug_sales_history), 0) AS total_money_generated`,
        [],
        executor
    );

    const heistsByType = await queryRows(
        `SELECT heist_type AS type,
            COUNT(*) AS total_count,
            COALESCE(SUM(gain), 0) AS total_gain
     FROM heists_history
     GROUP BY heist_type
     ORDER BY total_count DESC, type ASC`,
        [],
        executor
    );

    const drugSalesByType = await queryRows(
        `SELECT drug_type,
            COUNT(*) AS total_sales,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(revenue), 0) AS total_revenue
     FROM drug_sales_history
     GROUP BY drug_type
     ORDER BY total_sales DESC, drug_type ASC`,
        [],
        executor
    );

    const users = await queryRows(
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
     ORDER BY total_money_generated DESC, u.pseudo ASC`,
        [],
        executor
    );

    const totalPool = Number(totals?.total_money_generated || 0);
    const usersWithSalary = users.map((item) => {
        const totalMoneyGenerated = Number(item.total_money_generated || 0);
        const salaryPercentage = normalizeStoredOptionalPercentage(item.salary_percentage);
        const groupSharePercentage = normalizeStoredOptionalPercentage(item.group_share_percentage);
        const effectiveSalaryPercentage = salaryPercentage == null ? 35 : salaryPercentage;
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
            totalHeists: Number(totals?.total_heists || 0),
            totalDrugSales: Number(totals?.total_drug_sales || 0),
            totalMoneyGenerated: Number(totals?.total_money_generated || 0)
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
    return `backup-${scopeLabel}-${safeTimestamp}.json`;
}

function buildRelatedExportFileName(fileName, extension) {
    return fileName.replace(/\.json$/i, extension);
}

function getBackupList() {
    ensureBackupsDirectory();

    return fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => {
            const jsonPath = path.resolve(backupsDir, entry.name);
            const jsonStats = fs.statSync(jsonPath);
            const reportFileName = buildRelatedExportFileName(entry.name, '.html');
            const reportPath = path.resolve(backupsDir, reportFileName);

            return {
                fileName: entry.name,
                createdAt: jsonStats.mtime.toISOString(),
                sizeBytes: jsonStats.size,
                reportFileName: fs.existsSync(reportPath) ? reportFileName : null,
                jsonFileName: entry.name
            };
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createDatabaseBackup(scopeLabel) {
    ensureBackupsDirectory();

    const fileName = buildBackupFileName(scopeLabel);
    const jsonPath = path.resolve(backupsDir, fileName);
    const reportFileName = buildRelatedExportFileName(fileName, '.html');
    const reportPath = path.resolve(backupsDir, reportFileName);
    const snapshotData = await getBackupSnapshotData();

    fs.writeFileSync(jsonPath, JSON.stringify(snapshotData, null, 2), 'utf8');
    fs.writeFileSync(reportPath, buildBackupHtmlReport(snapshotData), 'utf8');

    const stats = fs.statSync(jsonPath);
    return {
        fileName,
        createdAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
        reportFileName,
        jsonFileName: fileName
    };
}

async function resetAllActivityData() {
    return withTransaction(async (client) => {
        const heistsDeletedRow = await queryOne(
            `WITH deleted AS (
         DELETE FROM heists_history
         WHERE heist_type NOT IN ('Armurie', 'Fleeca Bank')
         RETURNING id
       )
       SELECT COUNT(*) AS count FROM deleted`,
            [],
            client
        );

        const drugSalesDeletedRow = await queryOne(
            `WITH deleted AS (
         DELETE FROM drug_sales_history
         RETURNING id
       )
       SELECT COUNT(*) AS count FROM deleted`,
            [],
            client
        );

        await recomputeAllPlayerStats(client);

        return {
            heistsDeleted: Number(heistsDeletedRow?.count || 0),
            drugSalesDeleted: Number(drugSalesDeletedRow?.count || 0)
        };
    });
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

async function runWeeklyAutoResetIfDue() {
    const now = new Date();
    if (!isSundayAfterNineteen(now)) {
        return;
    }

    const weekKey = getIsoWeekKey(now);
    if (hasWeeklyAutoResetBeenProcessed(weekKey)) {
        return;
    }

    await createDatabaseBackup(`auto-reset-${weekKey}`);
    const result = await resetAllActivityData();
    console.log(
        `[AUTO RESET] Semaine ${weekKey} terminee - heists supprimes: ${result.heistsDeleted}, ventes drogues supprimees: ${result.drugSalesDeleted}`
    );
}

function startWeeklyAutomationScheduler() {
    runWeeklyAutoResetIfDue().catch((error) => {
        console.error('Echec automation hebdomadaire au demarrage:', error.message);
    });

    setInterval(() => {
        runWeeklyAutoResetIfDue().catch((error) => {
            console.error('Echec automation hebdomadaire:', error.message);
        });
    }, weeklyAutomationCheckIntervalMs);
}

function sanitizeBackupFileName(inputValue) {
    const fileName = String(inputValue || '');
    const safePattern = /^[a-zA-Z0-9._-]+\.(html|json)$/;

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
app.use(express.static(path.join(__dirname, '../../frontend')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.use('/api', healthRoutes);

app.get('/api/player/:id', async (req, res) => {
    const playerId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(playerId) || playerId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant joueur invalide.' });
    }

    try {
        const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId]);

        if (!player) {
            return res.status(404).json({ ok: false, error: 'Joueur introuvable.' });
        }

        return res.status(200).json({ ok: true, player });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement du joueur.', details: error.message });
    }
});

app.get('/api/activities/:playerId', async (req, res) => {
    const playerId = Number.parseInt(req.params.playerId, 10);

    if (!Number.isInteger(playerId) || playerId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant joueur invalide.' });
    }

    try {
        const activities = await queryRows(
            'SELECT * FROM activities WHERE player_id = $1 ORDER BY created_at DESC LIMIT 3',
            [playerId]
        );

        return res.status(200).json({ ok: true, activities });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des activites.', details: error.message });
    }
});

app.post('/api/activity', async (req, res) => {
    const { player_id: rawPlayerId, type, quantity, gain } = req.body || {};
    const playerId = Number.parseInt(rawPlayerId, 10);
    const parsedQuantity = Number(quantity);
    const parsedGain = Number(gain);

    if (!Number.isInteger(playerId) || playerId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant joueur invalide.' });
    }

    if (!String(type || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Type d activite requis.' });
    }

    if (!Number.isFinite(parsedQuantity) || !Number.isFinite(parsedGain)) {
        return res.status(400).json({ ok: false, error: 'Quantite et gain invalides.' });
    }

    try {
        await query(
            'INSERT INTO activities (player_id, type, quantity, gain) VALUES ($1, $2, $3, $4)',
            [playerId, String(type).trim(), parsedQuantity, parsedGain]
        );

        return res.status(201).json({ ok: true, success: true });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la creation de l activite.', details: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { pseudo, password } = req.body || {};

    if (!pseudo || !password) {
        return res.status(400).json({ ok: false, error: 'Pseudo et mot de passe requis.' });
    }

    try {
        const user = await queryOne(
            `SELECT users.id,
              users.pseudo,
              users.admin,
              users.grade,
              users.salary_percentage,
              users.group_share_percentage,
              grades.name AS grade_name
       FROM users
       LEFT JOIN grades ON grades.id = users.grade
       WHERE users.pseudo = $1 AND users.password = $2
       LIMIT 1`,
            [pseudo, password]
        );

        if (!user) {
            return res.status(401).json({ ok: false, error: 'Identifiants invalides.' });
        }

        return res.status(200).json({
            ok: true,
            token: 'demo-token-white-creams',
            user: formatUserPayload(user)
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la connexion.' });
    }
});

app.get('/api/dashboard/:pseudo', async (req, res) => {
    const pseudo = req.params.pseudo;

    try {
        const user = await getUserByPseudo(pseudo);
        if (!user) {
            return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
        }

        await ensurePlayerStatsRow(user.id);
        await recomputePlayerStats(user.id);

        const stats = await queryOne(
            `SELECT total_money, total_drugs_sold, total_heists
       FROM player_stats
       WHERE user_id = $1
       LIMIT 1`,
            [user.id]
        );

        const recentHeists = await queryRows(
            `SELECT heist_type, money_type, gain, heist_date
       FROM heists_history
       WHERE user_id = $1
       ORDER BY heist_date DESC, id DESC
       LIMIT 3`,
            [user.id]
        );

        return res.status(200).json({
            ok: true,
            user: formatUserPayload(user),
            summary: {
                totalMoney: Number(stats?.total_money || 0),
                totalDrugsSold: Number(stats?.total_drugs_sold || 0),
                totalHeists: Number(stats?.total_heists || 0)
            },
            recentHeists: recentHeists.map((heist) => ({
                name: heist.heist_type,
                moneyType: heist.money_type,
                gain: Number(heist.gain || 0),
                date: heist.heist_date
            }))
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement du dashboard.' });
    }
});

app.get('/api/casses/:pseudo', async (req, res) => {
    const pseudo = req.params.pseudo;

    try {
        const user = await getUserByPseudo(pseudo);
        if (!user) {
            return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });
        }

        await ensurePlayerStatsRow(user.id);

        const heists = await queryRows(
            `SELECT id, heist_type, money_type, participants, weapon, gain, heist_date
       FROM heists_history
       WHERE user_id = $1
       ORDER BY heist_date DESC, id DESC`,
            [user.id]
        );

        const drugSales = await queryRows(
            `SELECT id, drug_type, quantity, revenue, sale_date
       FROM drug_sales_history
       WHERE user_id = $1
       ORDER BY sale_date DESC, id DESC`,
            [user.id]
        );

        const activities = [
            ...heists.map((item) => ({
                id: `heist-${item.id}`,
                type: item.heist_type,
                moneyType: item.money_type || 'Sale',
                participants: parseParticipants(item.participants),
                weapon: item.weapon || null,
                gain: Number(item.gain || 0),
                date: item.heist_date,
                activityType: 'casse'
            })),
            ...drugSales.map((item) => ({
                id: `drug-${item.id}`,
                type: `Vente de drogues (${item.drug_type})`,
                drugType: item.drug_type,
                quantity: Number(item.quantity || 0),
                moneyType: 'Sale',
                gain: Number(item.revenue || 0),
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
            user: formatUserPayload(user),
            heists: activities
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des casses.' });
    }
});

app.get('/api/casses-options', async (req, res) => {
    try {
        const [heistTypes, drugTypes, users] = await Promise.all([
            queryRows('SELECT name FROM heist_types ORDER BY name'),
            queryRows('SELECT name FROM drug_types ORDER BY name'),
            queryRows('SELECT pseudo FROM users ORDER BY pseudo')
        ]);

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

app.post('/api/admin/:pseudo/drug-types', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const name = String(req.body?.name || '').trim();

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    if (!name) {
        return res.status(400).json({ ok: false, error: 'Nom de drogue requis.' });
    }

    try {
        const existing = await queryOne(
            'SELECT name FROM drug_types WHERE LOWER(name) = LOWER($1) LIMIT 1',
            [name]
        );

        if (existing) {
            return res.status(409).json({ ok: false, error: 'Ce type de drogue existe deja.' });
        }

        await query('INSERT INTO drug_types (name) VALUES ($1)', [name]);
        return res.status(201).json({ ok: true, drugType: { name } });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant lajout de type de drogue.' });
    }
});

app.delete('/api/admin/:pseudo/drug-types/:name', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const name = String(req.params.name || '').trim();

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    if (!name) {
        return res.status(400).json({ ok: false, error: 'Nom de drogue requis.' });
    }

    try {
        const existing = await queryOne(
            'SELECT id, name FROM drug_types WHERE LOWER(name) = LOWER($1) LIMIT 1',
            [name]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'Type de drogue introuvable.' });
        }

        const totalCount = await queryOne('SELECT COUNT(*) AS count FROM drug_types');
        if (Number(totalCount?.count || 0) <= 1) {
            return res.status(400).json({ ok: false, error: 'Impossible de supprimer le dernier type de drogue.' });
        }

        await query('DELETE FROM drug_types WHERE id = $1', [existing.id]);
        return res.status(200).json({ ok: true });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la suppression de type de drogue.' });
    }
});

app.get('/api/team-heists', async (req, res) => {
    try {
        const [limitsByType, heists] = await Promise.all([
            getAllTeamHeistLimitStatuses(),
            queryRows(
                `SELECT h.id,
                u.pseudo,
                h.heist_type,
                h.money_type,
                h.participants,
                h.weapon,
                h.gain,
                h.heist_date
         FROM heists_history h
         JOIN users u ON u.id = h.user_id
         WHERE h.heist_type IN ('Armurie', 'Fleeca Bank')
         ORDER BY h.heist_date DESC, h.id DESC`
            )
        ]);

        return res.status(200).json({
            ok: true,
            limits: {
                windowDays: TEAM_HEIST_LIMIT_WINDOW_DAYS,
                maxPerWindow: TEAM_HEIST_LIMIT_MAX,
                byType: limitsByType
            },
            heists: heists.map((item) => ({
                id: Number(item.id),
                pseudo: item.pseudo,
                type: item.heist_type,
                moneyType: item.money_type || 'Sale',
                participants: parseParticipants(item.participants),
                weapon: item.weapon || null,
                gain: Number(item.gain || 0),
                date: item.heist_date
            }))
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des casses equipe.' });
    }
});

app.get('/api/payes-summary', async (req, res) => {
    try {
        const [heistsByType, drugSalesByType, users] = await Promise.all([
            queryRows(
                `SELECT heist_type AS type,
                COUNT(*) AS total_count,
                COALESCE(SUM(gain), 0) AS total_gain
         FROM heists_history
         GROUP BY heist_type
         ORDER BY total_count DESC, type ASC`
            ),
            queryRows(
                `SELECT drug_type,
                COUNT(*) AS total_sales,
                COALESCE(SUM(quantity), 0) AS total_quantity,
                COALESCE(SUM(revenue), 0) AS total_revenue
         FROM drug_sales_history
         GROUP BY drug_type
         ORDER BY total_sales DESC, drug_type ASC`
            ),
            queryRows(
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
        ]);

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
                id: Number(item.id),
                pseudo: item.pseudo,
                isAdmin: Boolean(item.admin),
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

app.get('/api/admin/:pseudo/users-settings', async (req, res) => {
    const adminPseudo = req.params.pseudo;

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    try {
        const [grades, users] = await Promise.all([
            queryRows('SELECT id, name FROM grades ORDER BY id'),
            queryRows(
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
        ]);

        return res.status(200).json({
            ok: true,
            grades: grades.map((item) => ({ id: Number(item.id), name: item.name })),
            users: users.map((item) => ({
                id: Number(item.id),
                pseudo: item.pseudo,
                isAdmin: Boolean(item.admin),
                grade: item.grade == null ? null : Number(item.grade),
                gradeName: item.grade_name || null,
                salaryPercentage: normalizeStoredOptionalPercentage(item.salary_percentage),
                groupSharePercentage: normalizeStoredOptionalPercentage(item.group_share_percentage)
            }))
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement admin.' });
    }
});

app.post('/api/admin/:pseudo/users', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const { pseudo, password, grade, isAdmin, salaryPercentage, groupSharePercentage } = req.body || {};

    if (!(await isAdminPseudo(adminPseudo))) {
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
        const createdUser = await withTransaction(async (client) => {
            const gradeExists = await queryOne('SELECT id FROM grades WHERE id = $1 LIMIT 1', [parsedGrade], client);
            if (!gradeExists) {
                const error = new Error('Grade introuvable.');
                error.status = 400;
                throw error;
            }

            const existingUser = await queryOne('SELECT id FROM users WHERE pseudo = $1 LIMIT 1', [trimmedPseudo], client);
            if (existingUser) {
                const error = new Error('Ce pseudo existe deja.');
                error.status = 409;
                throw error;
            }

            const user = await queryOne(
                `INSERT INTO users (pseudo, password, admin, salary_percentage, group_share_percentage, grade)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, pseudo, admin, grade, salary_percentage, group_share_percentage`,
                [trimmedPseudo, rawPassword, Boolean(isAdmin), parsedSalaryPercentage, parsedGroupSharePercentage, parsedGrade],
                client
            );

            await ensurePlayerStatsRow(user.id, client);
            await recomputePlayerStats(user.id, client);

            return user;
        });

        return res.status(201).json({ ok: true, user: formatUserPayload(createdUser) });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la creation utilisateur.' });
    }
});

app.put('/api/admin/:pseudo/users/:id/settings', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const targetUserId = Number(req.params.id);
    const { grade, salaryPercentage, groupSharePercentage } = req.body || {};

    if (!(await isAdminPseudo(adminPseudo))) {
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
        const result = await withTransaction(async (client) => {
            const gradeExists = await queryOne('SELECT id FROM grades WHERE id = $1 LIMIT 1', [parsedGrade], client);
            if (!gradeExists) {
                const error = new Error('Grade introuvable.');
                error.status = 400;
                throw error;
            }

            const userExists = await queryOne('SELECT id FROM users WHERE id = $1 LIMIT 1', [targetUserId], client);
            if (!userExists) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            await client.query(
                'UPDATE users SET grade = $1, salary_percentage = $2, group_share_percentage = $3 WHERE id = $4',
                [parsedGrade, parsedPercentage, parsedGroupSharePercentage, targetUserId]
            );

            await recomputePlayerStats(targetUserId, client);
            return true;
        });

        return res.status(200).json({ ok: Boolean(result) });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la mise a jour admin.' });
    }
});

app.delete('/api/admin/:pseudo/users/:id', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const targetUserId = Number(req.params.id);

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant utilisateur invalide.' });
    }

    try {
        const deleted = await withTransaction(async (client) => {
            const targetUser = await queryOne(
                'SELECT id, pseudo, admin FROM users WHERE id = $1 LIMIT 1',
                [targetUserId],
                client
            );

            if (!targetUser) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            if (targetUser.pseudo === adminPseudo) {
                const error = new Error('Tu ne peux pas supprimer ton propre compte admin.');
                error.status = 400;
                throw error;
            }

            if (targetUser.admin) {
                const adminCount = await queryOne('SELECT COUNT(*) AS count FROM users WHERE admin = TRUE', [], client);
                if (Number(adminCount?.count || 0) <= 1) {
                    const error = new Error('Impossible de supprimer le dernier administrateur.');
                    error.status = 400;
                    throw error;
                }
            }

            const heistsDeleted = await queryOne('SELECT COUNT(*) AS count FROM heists_history WHERE user_id = $1', [targetUserId], client);
            const drugSalesDeleted = await queryOne('SELECT COUNT(*) AS count FROM drug_sales_history WHERE user_id = $1', [targetUserId], client);

            await client.query('DELETE FROM players WHERE name = $1', [targetUser.pseudo]);
            await client.query('DELETE FROM users WHERE id = $1', [targetUserId]);

            return {
                deletedUser: targetUser.pseudo,
                heistsDeleted: Number(heistsDeleted?.count || 0),
                drugSalesDeleted: Number(drugSalesDeleted?.count || 0)
            };
        });

        return res.status(200).json({ ok: true, ...deleted });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la suppression utilisateur.' });
    }
});

app.post('/api/admin/:pseudo/users/:id/reset-activity', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const targetUserId = Number(req.params.id);

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant utilisateur invalide.' });
    }

    try {
        const result = await withTransaction(async (client) => {
            const userExists = await queryOne('SELECT id, pseudo FROM users WHERE id = $1 LIMIT 1', [targetUserId], client);
            if (!userExists) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            const heistsDeleted = await queryOne(
                `WITH deleted AS (
           DELETE FROM heists_history WHERE user_id = $1 RETURNING id
         )
         SELECT COUNT(*) AS count FROM deleted`,
                [targetUserId],
                client
            );
            const drugSalesDeleted = await queryOne(
                `WITH deleted AS (
           DELETE FROM drug_sales_history WHERE user_id = $1 RETURNING id
         )
         SELECT COUNT(*) AS count FROM deleted`,
                [targetUserId],
                client
            );

            await recomputePlayerStats(targetUserId, client);

            return {
                resetUser: userExists.pseudo,
                heistsDeleted: Number(heistsDeleted?.count || 0),
                drugSalesDeleted: Number(drugSalesDeleted?.count || 0)
            };
        });

        return res.status(200).json({ ok: true, ...result });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la remise a zero des activites.' });
    }
});

app.post('/api/admin/:pseudo/reset-all-activity', async (req, res) => {
    const adminPseudo = req.params.pseudo;

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    try {
        const result = await resetAllActivityData();
        return res.status(200).json({ ok: true, ...result });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la remise a zero globale.' });
    }
});

app.get('/api/admin/:pseudo/backups', async (req, res) => {
    const adminPseudo = req.params.pseudo;

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    try {
        return res.status(200).json({ ok: true, backups: getBackupList() });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant le chargement des sauvegardes.' });
    }
});

app.post('/api/admin/:pseudo/backups', async (req, res) => {
    const adminPseudo = req.params.pseudo;

    if (!(await isAdminPseudo(adminPseudo))) {
        return res.status(403).json({ ok: false, error: 'Acces admin requis.' });
    }

    try {
        const backup = await createDatabaseBackup('manual');
        return res.status(201).json({ ok: true, backup });
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Erreur serveur pendant la creation de la sauvegarde.' });
    }
});

app.get('/api/admin/:pseudo/backups/:fileName', async (req, res) => {
    const adminPseudo = req.params.pseudo;
    const safeFileName = sanitizeBackupFileName(req.params.fileName);

    if (!(await isAdminPseudo(adminPseudo))) {
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

app.post('/api/casses/:pseudo/heists', async (req, res) => {
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

    try {
        const result = await withTransaction(async (client) => {
            if (isTeamHeist(type)) {
                const teamLimitStatus = await computeTeamHeistLimitStatus(type, new Date(), client);
                if (teamLimitStatus.isLocked) {
                    const unlockLabel = teamLimitStatus.lockedUntil
                        ? new Date(teamLimitStatus.lockedUntil).toLocaleString('fr-FR')
                        : 'dans 7 jours';
                    const error = new Error(`${type} limite a ${TEAM_HEIST_LIMIT_MAX} sur ${TEAM_HEIST_LIMIT_WINDOW_DAYS} jours. Reessayez le ${unlockLabel}.`);
                    error.status = 429;
                    error.payload = teamLimitStatus;
                    throw error;
                }
            }

            const user = await queryOne('SELECT id FROM users WHERE pseudo = $1 LIMIT 1', [pseudo], client);
            if (!user) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            const moneyType = await getHeistMoneyType(type, client);

            await client.query(
                `INSERT INTO heists_history (user_id, heist_name, city, heist_type, money_type, participants, weapon, gain, heist_date)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
                [user.id, type, 'Inconnue', type, moneyType, JSON.stringify(cleanedParticipants), safeWeapon, parsedGain, safeDate]
            );

            await recomputePlayerStats(user.id, client);
            return true;
        });

        return res.status(201).json({ ok: Boolean(result) });
    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({ ok: false, error: error.message, limit: error.payload });
        }

        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant lajout de casse.' });
    }
});

app.put('/api/casses/:pseudo/heists/:id', async (req, res) => {
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

    try {
        const updated = await withTransaction(async (client) => {
            const user = await queryOne('SELECT id FROM users WHERE pseudo = $1 LIMIT 1', [pseudo], client);
            if (!user) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            const existing = await queryOne(
                'SELECT id FROM heists_history WHERE id = $1 AND user_id = $2 LIMIT 1',
                [heistId, user.id],
                client
            );

            if (!existing) {
                const error = new Error('Casse introuvable.');
                error.status = 404;
                throw error;
            }

            const moneyType = await getHeistMoneyType(type, client);

            await client.query(
                `UPDATE heists_history
         SET heist_name = $1,
             city = $2,
             heist_type = $3,
             money_type = $4,
             participants = $5::jsonb,
             weapon = $6,
             gain = $7
         WHERE id = $8 AND user_id = $9`,
                [type, 'Inconnue', type, moneyType, JSON.stringify(cleanedParticipants), safeWeapon, parsedGain, heistId, user.id]
            );

            await recomputePlayerStats(user.id, client);
            return true;
        });

        return res.status(200).json({ ok: Boolean(updated) });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la modification de casse.' });
    }
});

app.post('/api/casses/:pseudo/drug-sales', async (req, res) => {
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
        const created = await withTransaction(async (client) => {
            const user = await queryOne('SELECT id FROM users WHERE pseudo = $1 LIMIT 1', [pseudo], client);
            if (!user) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            await client.query(
                'INSERT INTO drug_sales_history (user_id, drug_type, quantity, revenue, sale_date) VALUES ($1, $2, $3, $4, $5)',
                [user.id, safeType, parsedQuantity, parsedRevenue, safeDate]
            );

            await recomputePlayerStats(user.id, client);
            return true;
        });

        return res.status(201).json({ ok: Boolean(created) });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant lajout de vente de drogues.' });
    }
});

app.put('/api/casses/:pseudo/drug-sales/:id', async (req, res) => {
    const pseudo = req.params.pseudo;
    const saleId = Number(req.params.id);
    const { type, quantity, revenue } = req.body || {};
    const safeType = type || 'Inconnue';
    const parsedQuantity = Number(quantity || 0);
    const parsedRevenue = Number(revenue || 0);

    if (!Number.isFinite(saleId) || saleId <= 0) {
        return res.status(400).json({ ok: false, error: 'Identifiant de vente invalide.' });
    }

    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
        return res.status(400).json({ ok: false, error: 'Quantite invalide.' });
    }

    if (!Number.isFinite(parsedRevenue) || parsedRevenue < 0) {
        return res.status(400).json({ ok: false, error: 'Montant invalide.' });
    }

    try {
        const updated = await withTransaction(async (client) => {
            const user = await queryOne('SELECT id FROM users WHERE pseudo = $1 LIMIT 1', [pseudo], client);
            if (!user) {
                const error = new Error('Utilisateur introuvable.');
                error.status = 404;
                throw error;
            }

            const existing = await queryOne(
                'SELECT id FROM drug_sales_history WHERE id = $1 AND user_id = $2 LIMIT 1',
                [saleId, user.id],
                client
            );

            if (!existing) {
                const error = new Error('Vente de drogues introuvable.');
                error.status = 404;
                throw error;
            }

            await client.query(
                `UPDATE drug_sales_history
         SET drug_type = $1,
             quantity = $2,
             revenue = $3
         WHERE id = $4 AND user_id = $5`,
                [safeType, parsedQuantity, parsedRevenue, saleId, user.id]
            );

            await recomputePlayerStats(user.id, client);
            return true;
        });

        return res.status(200).json({ ok: Boolean(updated) });
    } catch (error) {
        return res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Erreur serveur pendant la modification de vente de drogues.' });
    }
});

app.get('/api/db-check', async (req, res) => {
    try {
        const response = {
            ok: true,
            supabase: {
                configured: hasConfiguredSupabase,
                connected: false,
                currentDatabase: null,
                currentUser: null,
                currentTime: null,
                totalUsers: null,
                error: null
            }
        };

        if (pgPool) {
            try {
                const status = await queryOne(
                    `SELECT current_database() AS database_name,
                  current_user AS user_name,
                  NOW() AS server_time,
                  (SELECT COUNT(*) FROM users) AS total_users`
                );

                response.supabase = {
                    configured: true,
                    connected: true,
                    currentDatabase: status?.database_name || null,
                    currentUser: status?.user_name || null,
                    currentTime: status?.server_time || null,
                    totalUsers: Number(status?.total_users || 0),
                    error: null
                };
            } catch (pgError) {
                response.supabase = {
                    configured: true,
                    connected: false,
                    currentDatabase: null,
                    currentUser: null,
                    currentTime: null,
                    totalUsers: null,
                    error: pgError.message
                };
            }
        }

        return res.status(200).json(response);
    } catch (error) {
        return res.status(500).json({ ok: false, error: 'Database connection failed', details: error.message });
    }
});

async function startServer() {
    if (!hasConfiguredSupabase || !pgPool) {
        throw new Error('Connexion Supabase non configuree. Renseigne DATABASE_URL ou les variables PG* / SUPABASE_DB_*.');
    }

    await database.initializeDatabase();
    await recomputeAllPlayerStats();
    startWeeklyAutomationScheduler();

    app.listen(PORT, () => {
        console.log('Serveur lance sur ' + PORT);
    });
}

startServer().catch((error) => {
    console.error('Echec du demarrage du serveur:', error.message);
    process.exit(1);
});
