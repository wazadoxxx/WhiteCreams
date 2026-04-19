# Base de projet web + base de donnees

Ce projet tourne avec une API Node.js + Express et une base Supabase PostgreSQL.

- `frontend/` : interface web statique (HTML/CSS/JS)
- `backend/` : API
- `database/init/001_schema.sql` : schema + donnees initiales PostgreSQL

## Demarrage local

```bash
cd backend
copy .env.example .env
npm install
npm run dev
```

Ensuite ouvre `frontend/login.html`.

## Variables d'environnement backend

- `PORT` : port HTTP du backend
- `SUPABASE_URL` : URL du projet Supabase
- `SUPABASE_ANON_KEY` : cle publique Supabase
- `SUPABASE_SERVICE_ROLE_KEY` : cle serveur Supabase si necessaire
- `DATABASE_URL` : URL PostgreSQL fournie par Supabase
- `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGPORT` : alternative si tu preferes renseigner la connexion PostgreSQL champ par champ
- `FRONTEND_URL` : URL frontend autorisee (ex: https://ton-front.vercel.app)
- `CORS_ORIGIN` : liste d'origines autorisees separees par des virgules

Exemple local:

```env
PORT=3000
SUPABASE_URL=https://ton-projet.supabase.co
SUPABASE_ANON_KEY=ton-anon-key
DATABASE_URL=postgresql://postgres:mot-de-passe@db.ton-projet.supabase.co:6543/postgres
FRONTEND_URL=http://127.0.0.1:5500
```

## Deploiement Supabase

1. Cree un projet Supabase.
2. Recupere l'URL du projet et les cles API dans `Project Settings > API`.
3. Recupere la chaine PostgreSQL dans `Project Settings > Database`.
4. Importe le schema contenu dans `database/init/001_schema.sql` dans l'editeur SQL Supabase.
5. Configure le backend avec `DATABASE_URL` ou les variables `PG*` / `SUPABASE_DB_*`.

Exemple :

```env
SUPABASE_URL=https://ton-projet.supabase.co
SUPABASE_ANON_KEY=ton-anon-key
SUPABASE_SERVICE_ROLE_KEY=ta-service-role-key
DATABASE_URL=postgresql://postgres:mot-de-passe@db.ton-projet.supabase.co:6543/postgres
FRONTEND_URL=https://ton-frontend-en-ligne
```

Le frontend lit l'URL API depuis :

1. la meta `api-base-url` (priorite 1),
2. puis `localStorage.API_BASE_URL`,
3. puis `window.location.origin`.

Dans chaque page HTML, mets l'URL de ton backend si ton frontend est sur un autre domaine :

```html
<meta name="api-base-url" content="https://ton-backend.example.com" />
```

## Donnees de connexion

Les identifiants viennent de `database/init/001_schema.sql`.

Exemple:

- pseudo: `pierre`
- password: `cailloux`

## Endpoints utiles

- `GET /api/health`
- `GET /api/db-check`
- `POST /api/auth/login`
