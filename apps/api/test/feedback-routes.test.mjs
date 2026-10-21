import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerFeedbackRoutes } from "../dist/feedback-routes.js";

test("feedback endpoint persists a bounded evaluation event", async () => {
  const events = [];
  const app = Fastify();
  registerFeedbackRoutes(app, {
    feedback: { append: async (event) => { events.push(event); } },
    revisions: { get: async () => ({ projectId: "project-1", revision: 1 }) },
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
    now: () => "2026-10-21T00:00:00.000Z",
  });
  const response = await app.inject({ method: "POST", url: "/v1/projects/project-1/feedback", payload: { revision: 1, type: "accepted", proposalId: "proposal-1", note: "Useful cut" } });
  assert.equal(response.statusCode, 201);
  assert.equal(events.length, 1);
  assert.equal(events[0].projectId, "project-1");
  assert.equal(events[0].type, "accepted");
  await app.close();
});


test("feedback rejects a proposal belonging to another project", async () => {
  const events = [];
  const app = Fastify();
  registerFeedbackRoutes(app, {
    feedback: { append: async (event) => { events.push(event); } },
    revisions: { get: async () => ({ projectId: "project-1", revision: 1 }) },
    proposals: { get: async () => ({ projectId: "project-2" }) },
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
    now: () => "2026-10-21T00:00:00.000Z",
  });
  const response = await app.inject({ method: "POST", url: "/v1/projects/project-1/feedback", payload: { revision: 1, type: "accepted", proposalId: "proposal-2" } });
  assert.equal(response.statusCode, 404);
  assert.equal(events.length, 0);
  await app.close();
});
