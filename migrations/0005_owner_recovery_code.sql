-- A recovery code, shown once when the owner sets the app up, replaces the setup code a
-- deploy form would otherwise have to ask for. Only its SHA-256 is stored; it is replaced
-- every time it is used.
ALTER TABLE owners ADD COLUMN recovery_hash TEXT;
