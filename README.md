# Base de projet web + base de donnees

Cette base fonctionne sans Docker et sans PostgreSQL, avec SQLite local.

- `frontend/` : interface web statique (HTML/CSS/JS)
- `backend/` : API Node.js + Express
- `database/init/001_schema.sql` : table users + donnees initiales
- `database/white_creams.sqlite` : base creee automatiquement au lancement

## Demarrage rapide

```bash
cd backend
copy .env.example .env
npm install
npm run dev
```

Ensuite, ouvre `frontend/login.html` dans ton navigateur.

## Donnees de connexion

Les identifiants utilises par le login viennent du fichier `database/init/001_schema.sql`.
Exemple :

- pseudo: `pierre`
- password: `cailloux`

## Endpoints utiles

- `GET /api/health`
- `GET /api/db-check`
- `POST /api/auth/login`
