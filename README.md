# Base de projet web + base de donnees

Ce projet tourne avec une API Node.js + Express et une base SQLite.

- `frontend/` : interface web statique (HTML/CSS/JS)
- `backend/` : API
- `database/init/001_schema.sql` : schema + donnees initiales

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
- `SQLITE_DB_FILE` : nom de fichier (ou chemin absolu) SQLite
- `SQLITE_DB_DIR` : dossier de stockage SQLite quand `SQLITE_DB_FILE` est relatif
- `FRONTEND_URL` : URL frontend autorisee (ex: https://ton-front.vercel.app)
- `CORS_ORIGIN` : liste d'origines autorisees separees par des virgules

Exemple local:

```env
PORT=3000
SQLITE_DB_FILE=white_creams.sqlite
SQLITE_DB_DIR=../database
FRONTEND_URL=http://127.0.0.1:5500
```

## Deploiement GitHub + Render

### Backend (Render Web Service)

1. Cree un Web Service Render connecte a ton repo GitHub.
2. Build command: `cd backend ; npm install`
3. Start command: `cd backend ; npm start`
4. Ajoute un disque persistant Render et monte-le sur `/var/data`.
5. Configure les variables Render:

```env
PORT=10000
SQLITE_DB_FILE=white_creams.sqlite
SQLITE_DB_DIR=/var/data
FRONTEND_URL=https://ton-frontend-en-ligne
```

Avec cette config, la DB SQLite est bien persistante et accessible en ligne via ton API Render.

### Frontend (statique)

Le frontend lit maintenant l'URL API depuis:

1. la meta `api-base-url` (priorite 1),
2. puis `localStorage.API_BASE_URL`,
3. puis `window.location.origin`.

Dans chaque page HTML, mets l'URL backend Render si ton frontend est sur un autre domaine:

```html
<meta name="api-base-url" content="https://ton-backend.onrender.com" />
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
