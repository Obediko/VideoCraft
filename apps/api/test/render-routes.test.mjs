import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRenderRoutes } from "../dist/render-routes.js";

test("render status and short-lived download URL are project-scoped", async () => {
  const app = Fastify();
  const jobs = new Map([["render-1", { id: "render-1", projectId: "project-1", revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "idem-12345678", status: "succeeded", progress: 100, output: { storageKey: "projects/project-1/renders/render-1.mp4", checksumSha256: "a".repeat(64), sizeBytes: 10, mimeType: "video/mp4" } }]]);
  registerRenderRoutes(app, {
    jobs: { get: async (id) => jobs.get(id), save: async () => undefined, update: async () => undefined },
    storage: { resolve: () => "unused", putFile: async () => { throw new Error("unused"); }, remove: async () => undefined },
    signingSecret: "s".repeat(32),
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
  });
  const response = await app.inject({ method: "GET", url: "/v1/projects/project-1/renders/render-1/download-url" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.url, /signature=/);
  assert.equal(body.expires > Math.floor(Date.now() / 1000), true);
  await app.close();
});


test("render downloads reject output keys outside the project scope", async () => {
  const app = Fastify();
  const jobs = new Map([["render-2", { id: "render-2", projectId: "project-1", revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "idem-87654321", status: "succeeded", progress: 100, output: { storageKey: "projects/project-2/renders/render-2.mp4", checksumSha256: "b".repeat(64), sizeBytes: 10, mimeType: "video/mp4" } }]]);
  registerRenderRoutes(app, {
    jobs: { get: async (id) => jobs.get(id), save: async () => undefined, update: async () => undefined },
    storage: { resolve: () => "unused", putFile: async () => { throw new Error("unused"); }, remove: async () => undefined },
    signingSecret: "s".repeat(32),
    authenticate: async () => ({ userId: "user-1" }),
    authorize: { canAccess: async () => true },
  });
  const response = await app.inject({ method: "GET", url: "/v1/projects/project-1/renders/render-2/download-url" });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('export history requires access and excludes storage credentials and foreign jobs', async () => {
  const app=Fastify(); let authenticated=true,allowed=true;
  const base={id:'job',projectId:'p',revision:2,status:'failed',progress:5,settings:{format:'mp4'},idempotencyKey:'private-key',output:{storageKey:'private-object'},errorMessage:'Transition failed'};
  registerRenderRoutes(app,{jobs:{get:async()=>undefined,save:async()=>{},update:async()=>{},listForProject:async()=>[base,{...base,id:'foreign',projectId:'other'}]},storage:{resolve:()=>'',putFile:async()=>{throw Error('unused')},remove:async()=>{}},signingSecret:'secret',authenticate:async()=>authenticated?{userId:'u'}:null,authorize:{canAccess:async()=>allowed}});
  const list=()=>app.inject({method:'GET',url:'/v1/projects/p/renders'});
  const response=await list(); assert.equal(response.statusCode,200);
  assert.equal(response.json().jobs.length,1);
  assert.equal(response.json().jobs[0].errorMessage,'Transition failed');
  assert.equal(response.json().jobs[0].output,undefined);
  assert.equal(response.json().jobs[0].idempotencyKey,undefined);
  allowed=false; assert.equal((await list()).statusCode,403);
  authenticated=false; assert.equal((await list()).statusCode,401);
  await app.close();
});

test('late cancellation reports a completed export instead of claiming it was cancelled', async () => {
  const app=Fastify();
  let job={id:'race',projectId:'p',revision:1,settings:{format:'mp4'},idempotencyKey:'key',status:'running',progress:25};
  registerRenderRoutes(app,{jobs:{get:async()=>job,save:async()=>{},update:async()=>{job={...job,status:'succeeded',progress:100};}},storage:{resolve:()=>'',putFile:async()=>{throw Error('unused')},remove:async()=>{}},signingSecret:'secret',authenticate:async()=>({userId:'u'}),authorize:{canAccess:async()=>true}});
  const response=await app.inject({method:'POST',url:'/v1/projects/p/renders/race/cancel'});
  assert.equal(response.statusCode,409);
  assert.equal(job.status,'succeeded');
  await app.close();
});
