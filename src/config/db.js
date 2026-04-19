const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const databaseUrl = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const pgHost = String(process.env.PGHOST || process.env.SUPABASE_DB_HOST || '').trim();
const pgUser = String(process.env.PGUSER || process.env.SUPABASE_DB_USER || '').trim();
const pgDatabase = String(process.env.PGDATABASE || process.env.SUPABASE_DB_NAME || '').trim();
const pgPassword = String(process.env.PGPASSWORD || process.env.SUPABASE_DB_PASSWORD || '').trim();
const pgPort = Number(process.env.PGPORT || process.env.SUPABASE_DB_PORT || 5432);
const hasConfiguredSupabase = Boolean(databaseUrl || (pgHost && pgUser && pgDatabase && pgPassword));

let pgPool = null;

if (hasConfiguredSupabase) {
    pgPool = new Pool(
        databaseUrl
            ? {
                connectionString: databaseUrl,
                ssl: {
                    rejectUnauthorized: false
                }
            }
            : {
                user: pgUser,
                host: pgHost,
                database: pgDatabase,
                password: pgPassword,
                port: pgPort,
                ssl: {
                    rejectUnauthorized: false
                }
            }
    );
}

const initSqlPath = path.resolve(__dirname, '..', '..', '..', 'database', 'init', '001_schema.sql');
let initPromise = null;

async function initializeDatabase() {
    if (!pgPool || initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        if (!fs.existsSync(initSqlPath)) {
            return;
        }

        const initSql = fs.readFileSync(initSqlPath, 'utf8').trim();
        if (!initSql) {
            return;
        }

        await pgPool.query(initSql);
    })();

    return initPromise;
}

module.exports = {
    pgPool,
    hasConfiguredSupabase,
    hasConfiguredPostgres: hasConfiguredSupabase,
    supabaseUrl: supabaseUrl || null,
    initializeDatabase
};
