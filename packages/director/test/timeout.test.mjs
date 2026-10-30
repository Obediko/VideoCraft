import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenAiDirector } from '../dist/index.js';

test('director deadline covers a stalled response body after headers arrive', async () => {
  let bodyAborted = false;
  const input = { brief: 'test', durationS: 5, frame: { width: 640, height: 360 }, transcript: [], candidates: [], frames: [], assets: [] };
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    res.on('close', () => { if (!res.writableEnded) bodyAborted = true; });
    // Eventually finish so the unfixed implementation fails rather than hanging the suite.
    const timer = setTimeout(() => res.end('{}'), 800);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const director = new OpenAiDirector({ apiKey: 'test', model: 'test', endpoint: `http://127.0.0.1:${server.address().port}`, timeoutMs: 150 });
    const plan = await director.plan(input);
    assert.match(plan.note, /timed out/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodyAborted, true, 'the connection should be aborted at the deadline');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
