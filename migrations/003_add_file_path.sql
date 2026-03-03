-- Store relative path within MEGA folder to preserve directory structure

ALTER TABLE files ADD COLUMN path TEXT NOT NULL DEFAULT '';
