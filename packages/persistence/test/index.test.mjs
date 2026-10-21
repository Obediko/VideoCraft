import test from "node:test";
import assert from "node:assert/strict";
import { PostgresProjectRepository } from "../dist/index.js";

test("project repository uses parameterized queries", async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{
        id: "project-1",
        owner_id: "user-1",
        name: "Demo",
        revision: 0,
        created_at: "2026-10-21T00:00:00.000Z",
        updated_at: "2026-10-21T00:00:00.000Z"
      }] };
    }
  };
  const project = await new PostgresProjectRepository(db).get("project-1");
  assert.equal(project.ownerId, "user-1");
  assert.deepEqual(calls[0].values, ["project-1"]);
  assert.match(calls[0].text, /WHERE id = \$1/);
});
