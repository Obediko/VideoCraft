import test from "node:test";
import assert from "node:assert/strict";
import { PostgresProjectRepository, PostgresSceneRepository } from "../dist/index.js";

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


test("scene replacement uses the database transaction boundary", async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    },
    async transaction(work) {
      calls.push({ text: "BEGIN" });
      const result = await work({ query: this.query.bind(this) });
      calls.push({ text: "COMMIT" });
      return result;
    }
  };
  await new PostgresSceneRepository(db).replaceForAsset("asset-1", [{
    id: "scene-1",
    assetId: "asset-1",
    startUs: 0,
    endUs: 1_000_000,
    createdAt: "2026-10-21T00:00:00.000Z"
  }]);
  assert.deepEqual(calls.map((call) => call.text), [
    "BEGIN",
    "DELETE FROM scenes WHERE asset_id = $1",
    "INSERT INTO scenes (id, asset_id, start_us, end_us, created_at) VALUES ($1, $2, $3, $4, $5)",
    "COMMIT"
  ]);
});
