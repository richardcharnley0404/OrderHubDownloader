/**
 * src/main/services/ai-inference-host.js
 *
 * Electron utilityProcess host for ONNX inference (PW-007 Phase 1 — refactor).
 *
 * This script runs in a separate OS process spawned via Electron's
 * utilityProcess.fork(). Communication is exclusively via
 * `process.parentPort.{on('message'), postMessage()}` — no Node `process.send`,
 * no IPC channels.
 *
 * Step 2 scope (current):
 *   - Lifecycle: emit `{ kind: 'ready', loadedModels, executionProvider }`
 *     after attempting to load every registered model.
 *   - Messages: `ping` → `pong`, `inference` → real ONNX run, `shutdown` →
 *     graceful exit.
 *   - Model loading is best-effort: a missing or broken model is logged but
 *     does not block ready (the missing model is simply absent from
 *     `loadedModels`). The corresponding inference requests will reply with
 *     `MODEL_NOT_LOADED`.
 *
 * Message protocol mirrors `docs/refactor-onnx-utilityprocess.md` § 4.
 */

'use strict';

const path = require('path');

// utilityProcess does NOT have process.send — it uses parentPort.
// If parentPort is missing, this script was launched outside utilityProcess
// (e.g. directly via `node ai-inference-host.js`) — bail loudly so we don't
// silently misbehave.
if (!process.parentPort) {
  // eslint-disable-next-line no-console
  console.error('[ai-host] FATAL: process.parentPort is undefined — ai-inference-host.js must be launched via Electron utilityProcess.fork()');
  process.exit(1);
}

const parentPort = process.parentPort;

// ---------------------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------------------

function send(message) {
  try {
    parentPort.postMessage(message);
  } catch (err) {
    // Last-ditch console; the parent's logger forwarder may not be wired yet.
    // eslint-disable-next-line no-console
    console.error('[ai-host] postMessage failed:', err);
  }
}

function log(level, message, meta) {
  send({
    kind: 'log',
    level,        // 'info' | 'warn' | 'error'
    message,
    meta: meta || null,
    tag: '[ai-host]',
  });
}

function reply(id, ok, payload) {
  send(ok
    ? { id, ok: true, result: payload }
    : { id, ok: false, error: payload });
}

// ---------------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------------

parentPort.on('message', (event) => {
  // Electron utilityProcess asymmetry: on the host side, the listener
  // receives a MessageEvent-shaped object whose payload is on `.data`.
  // (On the main side, `child.on('message', ...)` already gets the raw data.)
  // Be defensive — accept both shapes in case the wrapping ever changes.
  const msg = event && typeof event === 'object' && 'data' in event
    ? event.data
    : event;

  if (!msg || typeof msg !== 'object') {
    log('warn', `ignored non-object message: ${typeof msg}`);
    return;
  }

  const { id, kind } = msg;

  switch (kind) {
    case 'ping':
      reply(id, true, { pong: true, pid: process.pid, uptime: process.uptime() });
      break;

    case 'inference':
      handleInference(id, msg).catch((err) => {
        log('error', `inference handler threw: ${err && err.message}`, { stack: err && err.stack });
        reply(id, false, {
          message: err && err.message ? err.message : 'inference handler threw',
          code: 'INFERENCE_FAILED',
        });
      });
      break;

    case 'shutdown':
      log('info', 'shutdown requested — exiting');
      // Give the parent a moment to flush the log forward.
      setTimeout(() => process.exit(0), 50);
      break;

    default:
      log('warn', `unknown message kind: ${kind}`);
      if (id) {
        reply(id, false, {
          message: `unknown message kind: ${kind}`,
          code: 'BAD_INPUT',
        });
      }
  }
});

// ---------------------------------------------------------------------------
// Model registry + loading
// ---------------------------------------------------------------------------

// Lazy-required so a missing native binding fails inside the try/catch
// rather than crashing the host on import.
let ort = null;
const loaders = new Map();        // modelId → loader module (orientation-loader, etc)
const sessions = new Map();       // modelId → ort.InferenceSession
const modelVersions = new Map();  // modelId → version string (filename stem)
let executionProvider = 'none';   // populated after ort is initialised

function detectExecutionProvider() {
  // Step 2: report 'cpu' if onnxruntime-node loaded successfully.
  // Step 4 (or later) may attempt DirectML EP detection. For now we just
  // accept the runtime's default. ort.InferenceSession.create can take an
  // executionProviders option, but probing it requires a session that
  // may fail differently per platform — punted.
  return ort ? 'cpu' : 'none';
}

async function loadAllModels(modelOverrides) {
  // Lazy require — keeps the import error localised and reported.
  try {
    ort = require('onnxruntime-node');
  } catch (err) {
    log('error', `failed to require onnxruntime-node: ${err && err.message}`, { stack: err && err.stack });
    return;
  }

  // Register each known model loader. New models (musiq, fbcnn, realesrgan)
  // get added here in their respective milestones.
  let orientationLoader;
  try {
    orientationLoader = require('./ai-inference-models/orientation-loader');
    loaders.set(orientationLoader.modelId, orientationLoader);
  } catch (err) {
    log('error', `failed to require orientation-loader: ${err && err.message}`, { stack: err && err.stack });
  }

  // Attempt to create a session for each registered model.
  for (const [modelId, loader] of loaders) {
    try {
      const override = modelOverrides && modelOverrides[modelId];
      const modelPath = loader.resolveModelPath(override);

      if (!require('fs').existsSync(modelPath)) {
        log('warn', `model file not found for '${modelId}' at ${modelPath} — skipping`);
        continue;
      }

      const t0 = Date.now();
      const session = await ort.InferenceSession.create(modelPath);
      const loadMs = Date.now() - t0;

      sessions.set(modelId, session);
      modelVersions.set(modelId, path.basename(loader.modelFile, '.onnx'));
      log('info',
        `model '${modelId}' loaded — ${loader.modelFile} in ${loadMs}ms ` +
        `(inputs=${session.inputNames.join(',')}, outputs=${session.outputNames.join(',')})`
      );

      // Warmup: run one zero-tensor inference to pay JIT/graph compilation now.
      await warmupSession(modelId, loader, session);
    } catch (err) {
      log('error', `failed to load model '${modelId}': ${err && err.message}`, { stack: err && err.stack });
    }
  }

  executionProvider = detectExecutionProvider();
}

async function warmupSession(modelId, loader, session) {
  if (!loader.imageSize || !loader.inputName) return;
  const size = loader.imageSize;
  const zeros = new Float32Array(3 * size * size);
  const tensor = new ort.Tensor('float32', zeros, [1, 3, size, size]);
  const t0 = Date.now();
  try {
    await session.run({ [loader.inputName]: tensor });
    log('info', `model '${modelId}' warmup ${Date.now() - t0}ms`);
  } catch (err) {
    log('warn', `model '${modelId}' warmup failed (non-fatal): ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Inference handler
// ---------------------------------------------------------------------------

async function handleInference(id, msg) {
  const startedAt = Date.now();
  const { modelId, input } = msg;

  if (!modelId || typeof modelId !== 'string') {
    return reply(id, false, { message: 'inference: missing modelId', code: 'BAD_INPUT' });
  }

  const loader = loaders.get(modelId);
  const session = sessions.get(modelId);

  if (!loader || !session) {
    return reply(id, false, {
      message: `model '${modelId}' not loaded`,
      code: 'MODEL_NOT_LOADED',
    });
  }

  if (!input || typeof input !== 'object') {
    return reply(id, false, { message: 'inference: missing input object', code: 'BAD_INPUT' });
  }

  const { imagePath } = input;
  if (!imagePath || typeof imagePath !== 'string') {
    return reply(id, false, {
      message: "inference: input.imagePath required (string)",
      code: 'BAD_INPUT',
    });
  }

  if (!require('fs').existsSync(imagePath)) {
    return reply(id, false, {
      message: `image not found: ${imagePath}`,
      code: 'BAD_INPUT',
    });
  }

  // Preprocess → run → postprocess.
  let tensor;
  try {
    tensor = await loader.prepareTensor(imagePath, ort);
  } catch (err) {
    return reply(id, false, {
      message: `prepareTensor failed: ${err && err.message}`,
      code: 'INFERENCE_FAILED',
    });
  }

  let output;
  try {
    output = await session.run({ [loader.inputName]: tensor });
  } catch (err) {
    return reply(id, false, {
      message: `session.run failed: ${err && err.message}`,
      code: 'INFERENCE_FAILED',
    });
  }

  let result;
  try {
    const logits = Array.from(output[loader.outputName].data);
    result = loader.postprocess(logits);
  } catch (err) {
    return reply(id, false, {
      message: `postprocess failed: ${err && err.message}`,
      code: 'INFERENCE_FAILED',
    });
  }

  result.inferenceMs = Date.now() - startedAt;
  return reply(id, true, result);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Surface uncaught failures to the parent rather than dying silently.
process.on('uncaughtException', (err) => {
  log('error', `uncaughtException: ${err && err.message}`, { stack: err && err.stack });
  // Let the parent decide whether to restart us; do not exit eagerly.
});

process.on('unhandledRejection', (reason) => {
  log('error', `unhandledRejection: ${reason && reason.message ? reason.message : String(reason)}`);
});

// Boot sequence: load models (best-effort) → announce ready with the loaded
// model list. In Step 4 the main process will receive optional model
// overrides via fork() args; for now load with defaults.
(async () => {
  await loadAllModels(/* overrides: none yet */);
  send({
    kind: 'ready',
    loadedModels: Array.from(sessions.keys()),
    modelVersions: Object.fromEntries(modelVersions),
    executionProvider,
    pid: process.pid,
  });
})().catch((err) => {
  log('error', `boot sequence threw: ${err && err.message}`, { stack: err && err.stack });
  // Emit a degraded ready so the client doesn't time out — features will
  // simply have no models loaded and inference will reply MODEL_NOT_LOADED.
  send({
    kind: 'ready',
    loadedModels: [],
    modelVersions: {},
    executionProvider: 'none',
    pid: process.pid,
  });
});
