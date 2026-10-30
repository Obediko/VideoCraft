import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FasterWhisperWorker } from '../dist/index.js';

test('worker exit during stdin write rejects instead of crashing the API process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-worker-failure-'));
  try {
    const script = join(dir, 'exit.cjs');
    await writeFile(script, "process.stderr.write('model unavailable'); process.exit(1);");
    const worker = new FasterWhisperWorker({ pythonCommand: process.execPath, workerPath: script, mediaRoot: dir, timeoutMs: 1000 });
    // Exceed the pipe buffer to deterministically exercise the broken-pipe path.
    await assert.rejects(worker.transcribe({ id: 'x'.repeat(1024 * 1024), storageKey: 'input.mp4' }), /Transcription worker/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing worker executable rejects promptly', async () => {
  const worker = new FasterWhisperWorker({ pythonCommand: '/nonexistent-videocraft-python', workerPath: 'worker.py', mediaRoot: tmpdir(), timeoutMs: 1000 });
  await assert.rejects(worker.transcribe({ id: 'asset', storageKey: 'input.mp4' }), /ENOENT|Transcription worker/);
});
