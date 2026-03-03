-- Add retry tracking to files and folders

ALTER TABLE files ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
