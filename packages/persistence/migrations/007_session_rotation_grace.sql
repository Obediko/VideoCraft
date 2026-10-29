-- Refresh-token rotation marks the old session as rotated (not logged out), so a concurrent refresh from another
-- tab that still holds the old cookie within a short grace window is accepted instead of signing the person out.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
