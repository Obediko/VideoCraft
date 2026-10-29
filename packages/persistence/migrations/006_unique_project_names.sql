-- Project names are unique per owner (ignoring case and repeated spaces).
-- Existing duplicates are renamed first, oldest keeps its name: "My first cut", "My first cut (2)", "My first cut (3)", ...
DO $$
DECLARE
  r record;
  candidate text;
  k integer;
BEGIN
  FOR r IN
    SELECT id, owner_id, name,
           row_number() OVER (PARTITION BY owner_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) ORDER BY created_at, id) AS n
    FROM projects
  LOOP
    IF r.n > 1 THEN
      k := r.n;
      LOOP
        candidate := left(regexp_replace(btrim(r.name), '\s+', ' ', 'g'), 110) || ' (' || k || ')';
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM projects
          WHERE owner_id = r.owner_id AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(candidate)
        );
        k := k + 1;
      END LOOP;
      UPDATE projects SET name = candidate WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_name_unique
  ON projects (owner_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));
