CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO grades (name) VALUES
('Leader'),
('Co-Leader'),
('Officier'),
('Membre Confirmé'),
('Membre');

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT 0,
    salary_percentage REAL,
    group_share_percentage REAL,
    grade INTEGER,
    FOREIGN KEY (grade) REFERENCES grades(id)
);

INSERT OR IGNORE INTO users (pseudo, password, grade ,admin) VALUES
('Cailloux', '234Kito234!', 1, 1),
('GigiStone', 'PieGiuSto', 2, 0),
('Caribou', 'nicktamere30x', 3, 0),
('Raven.ws', 'Ravs1903@/', 3, 0),
('nico_offi', 'Nicoathena20', 4, 0),
('Mike21', 'Niquelesarabes8+', 4, 0),
('Matt', 'ViveLaMéca', 5, 0),
('Jondelaplace', 'compta2026', 5, 0),
('PapyBarlou', 'kacem-wapalek-ouil', 5, 0),
('Daryl', 'Whitecreams', 3, 1);

UPDATE users
SET pseudo = 'GigiStone'
WHERE pseudo = 'GigiStone '
    AND NOT EXISTS (SELECT 1 FROM users WHERE pseudo = 'GigiStone');

UPDATE users
SET pseudo = 'Daryl'
WHERE pseudo = 'daryl'
    AND NOT EXISTS (SELECT 1 FROM users WHERE pseudo = 'Daryl');

UPDATE users
SET pseudo = 'Matt'
WHERE pseudo = 'Mat'
    AND NOT EXISTS (SELECT 1 FROM users WHERE pseudo = 'Matt');

INSERT INTO users (pseudo, password, grade, admin) VALUES
('Cailloux', '234Kito234!', 1, 1),
('GigiStone', 'PieGiuSto', 2, 0),
('Caribou', 'nicktamere30x', 3, 0),
('Raven.ws', 'Ravs1903@/', 3, 0),
('nico_offi', 'Nicoathena20', 4, 0),
('Mike21', 'Niquelesarabes8+', 4, 0),
('Matt', 'ViveLaMéca', 5, 0),
('Jondelaplace', 'compta2026', 5, 0),
('PapyBarlou', 'kacem-wapalek-ouil', 5, 0),
('Daryl', 'Whitecreams', 3, 1)
ON CONFLICT(pseudo) DO UPDATE SET
        password = excluded.password,
        grade = excluded.grade,
        admin = excluded.admin;

DELETE FROM player_stats
WHERE user_id IN (
    SELECT id
    FROM users
    WHERE pseudo IN ('bob', 'daryl', 'georges', 'giulia', 'jon', 'mike', 'nico', 'pierre', 'raven')
);

DELETE FROM users
WHERE pseudo IN ('bob', 'daryl', 'georges', 'giulia', 'jon', 'mike', 'nico', 'pierre', 'raven');

INSERT OR IGNORE INTO heist_types (name, money_type) VALUES
('Go-Fast', 'Sale'),
('Superette', 'Sale'),
('ATM', 'Sale'),
('Cambriolage', 'Propre'),
('Armurie', 'Sale'),
('Fleeca Bank', 'Sale');

UPDATE heist_types
SET money_type = CASE
    WHEN name = 'Cambriolage' THEN 'Propre'
    ELSE 'Sale'
END;

INSERT OR IGNORE INTO drug_types (name) VALUES
('Sporex'),
('Heroine'),
('Mexicana'),
('Lean'),
('Ectazy'),
('Cocaine'),
('Tranq'),
('Meth Bleu'),
('B-Magic');

