/**
 * src/main/services/ai-inference-client.js
 *
 * Main-process client for the AI inference utilityProcess host.
 *
 * Public API:
 *   await aiInferenceClient.init()          // optional explicit init; first
 *                                              call to .ping()/.run() also inits
 *   await aiInferenceClient.ping()          // → { pong: true, pid, uptime }
 *   await aiInferenceClient.run(modelId, input)  // → host result (Step 2+)
 *   await aiInferenceClient.shutdown()      // graceful close
 *   aiInferenceClient.isReady()             // boolean
 *
 * Step 1 scope:
 *   - Spawn the host via Electron utilityProcess.fork().
 *   - Correlate request/response by uuid id.
 *   - Forward host log messages into Winston with [ai-host] tag.
 *   - Reject in-flight requests if the host exits before responding.
 *
 * NOT in Step 1:
 *   - Auto-restart on crash (Step 4).
 *   - Concurrency capping (deferred — added with Quality Gate).
 */

'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const electron = require('electron');
const logger = require('./logger');

// `utilityProcess` is a top-level export on the electron module in main.
// Available since Electron v22; project is on 40.x.
const { utilityProcess } = electron;

const HOST_SCRIPT = path.join(__dirname, 'ai-inference-host.js');

// Default: how long ping/run will wait before rejecting if the host never
// answers. Inference itself can take seconds; this is a safety net for
// "host hung / never started", not a per-request budget.
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// Default: how long to wait for the host to emit `ready` after fork().
const READY_TIMEOUT_MS = 15000;

// Crash recovery window: if the host crashes a second time within this many
// milliseconds of the first crash, we give up and disable AI for the session.
// Single-crash recovery (auto-restart once) is silent; double-crash trips
// the kill-switch.
const CRASH_RECOVERY_WINDOW_MS = 30000;

class AIInferenceClient {
  constructor() {
    this._child = null;                    // utilityProcess child handle
    this._ready = false;                   // true once host has emitted 'ready'
    this._readyPromise = null;             // resolves when host is ready
    this._initPromise = null;              // single-flight init guard
    this._pending = new Map();             // id -> { resolve, reject, timer }
    this._loadedModels = [];               // populated from 'ready'
    this._modelVersions = {};              // populated from 'ready'
    this._executionProvider = 'none';      // populated from 'ready'

    // Crash + restart bookkeeping (Step 4).
    this._intentionalShutdown = false;     // true between shutdown() and exit
    this._firstCrashAt = 0;                // ms timestamp of first crash this session
    this._restartCount = 0;                // # of auto-restarts attempted
    this._restartInFlight = false;         // true while we're auto-restarting
    this._disabledForSession = false;      // tripped after a double-crash;
                                           // clears only on app restart
  }

  isReady() {
    return this._ready;
  }

  getLoadedModels() {
    return [...this._loadedModels];
  }

  getModelVersion(modelId) {
    return this._modelVersions[modelId] || null;
  }

  getExecutionProvider() {
    return this._executionProvider;
  }

  hasModel(modelId) {
    return this._loadedModels.indexOf(modelId) >= 0;
  }

  isDisabledForSession() {
    return this._disabledForSession;
  }

  /**
   * Spawn the host (idempotent). Resolves once the host emits 'ready'.
   * Subsequent callers share the same promise.
   *
   * If the host has been disabled for the session due to repeated crashes,
   * this throws — callers (orientation-service, ai-quality-service) treat
   * that as "feature unavailable" and degrade gracefully.
   */
  async init() {
    if (this._disabledForSession) {
      const err = new Error('ai-inference-host disabled for this session after repeated crashes');
      err.code = 'DISABLED_FOR_SESSION';
      throw err;
    }
    if (this._ready) return true;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._spawn().catch((err) => {
      // On init failure, clear the latch so a future call can retry. The
      // caller decides whether to retry — we do not auto-retry here.
      this._initPromise = null;
      throw err;
    });
    return this._initPromise;
  }

  async ping() {
    return this._request('ping');
  }

  /**
   * Send an inference request. Step 1 host returns NOT_IMPLEMENTED for any
   * modelId — this method exists so orientation-service can be wired against
   * its final shape from Step 3 onward.
   */
  async run(modelId, input, opts) {
    return this._request('inference', { modelId, input }, opts);
  }

  async shutdown() {
    if (!this._child) return;

    // Best-effort graceful close. If the host doesn't honour it within the
    // grace window, kill it. Set the flag so _onExit knows this exit is
    // intentional and won't trigger restart logic.
    this._intentionalShutdown = true;
    const child = this._child;

    try {
      child.postMessage({ kind: 'shutdown' });
    } catch (_) { /* host may already be gone */ }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* already dead */ }
        resolve();
      }, 2000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this._teardown();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  _spawn() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = utilityProcess.fork(HOST_SCRIPT, [], {
          serviceName: 'ohd-ai-inference-host',
          stdio: 'pipe',
          // env stays inherited from main; allow overrides later if needed.
        });
      } catch (err) {
        return reject(new Error(`utilityProcess.fork failed: ${err && err.message}`));
      }

      this._child = child;

      // Capture stdout/stderr — the host should use `log` messages, but if
      // it console.error()s before the message channel is up (or post-crash),
      // we still want to see it.
      if (child.stdout) {
        child.stdout.on('data', (buf) => {
          const text = String(buf).trimEnd();
          if (text) logger.info(`[ai-host:stdout] ${text}`);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (buf) => {
          const text = String(buf).trimEnd();
          if (text) logger.error(`[ai-host:stderr] ${text}`);
        });
      }

      const readyTimer = setTimeout(() => {
        this._teardown();
        reject(new Error(`ai-inference-host did not emit 'ready' within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      // Single message listener for the lifetime of this child. It handles
      // `ready`, log forwarding, and request/response correlation. Attaching
      // it up-front (rather than waiting for ready) means log messages
      // emitted by the host during boot — model loading, warmup, etc — are
      // forwarded into Winston instead of being dropped.
      const onMessage = (msg) => {
        if (msg && msg.kind === 'ready' && !this._ready) {
          clearTimeout(readyTimer);
          this._ready = true;
          this._loadedModels = msg.loadedModels || [];
          this._modelVersions = msg.modelVersions || {};
          this._executionProvider = msg.executionProvider || 'none';
          logger.info(
            `[ai-host] ready (pid=${msg.pid}, models=[${this._loadedModels.join(',')}], ep=${this._executionProvider})`
          );
          resolve(true);
          return;
        }
        this._onMessage(msg);
      };
      child.on('message', onMessage);

      child.on('exit', (code) => this._onExit(code));
    });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Forwarded log entries from the host.
    if (msg.kind === 'log') {
      const level = msg.level || 'info';
      const text = `${msg.tag || '[ai-host]'} ${msg.message}`;
      if (typeof logger[level] === 'function') {
        logger[level](text, msg.meta || {});
      } else {
        logger.info(text, msg.meta || {});
      }
      return;
    }

    // Request/response correlation — anything with an `id` matching a pending
    // request resolves/rejects that request's promise.
    if (msg.id && this._pending.has(msg.id)) {
      const entry = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const err = new Error((msg.error && msg.error.message) || 'inference failed');
        err.code = (msg.error && msg.error.code) || 'INFERENCE_FAILED';
        entry.reject(err);
      }
      return;
    }

    // Anything else (unknown protocol message) — log and ignore.
    logger.warn(`[ai-host] unhandled message kind: ${msg.kind}`);
  }

  _onExit(code) {
    const wasIntentional = this._intentionalShutdown;
    logger.warn(`[ai-host] exited (code=${code}, intentional=${wasIntentional})`);

    // Reject anything still in-flight. New requests issued before the
    // restart completes will queue against the new host via init().
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      const err = new Error('ai-inference-host exited before responding');
      err.code = 'INFERENCE_FAILED';
      entry.reject(err);
      this._pending.delete(id);
    }

    this._teardown();

    if (wasIntentional) {
      // Graceful shutdown via shutdown() — do not restart.
      return;
    }

    if (this._disabledForSession || this._restartInFlight) {
      return;
    }

    // Crash path. The recovery rule is:
    //   - First crash this session → auto-restart once after a short delay.
    //   - Second crash within CRASH_RECOVERY_WINDOW_MS of the first → give
    //     up: disable AI for the session. Caller fallbacks (orientation-service
    //     returns "no rotation" results) keep the rest of OHD running.
    const now = Date.now();
    const sinceFirstCrashMs = this._firstCrashAt ? (now - this._firstCrashAt) : Infinity;

    if (this._restartCount > 0 && sinceFirstCrashMs < CRASH_RECOVERY_WINDOW_MS) {
      this._disabledForSession = true;
      logger.error(
        `[ai-host] disabled for session — crashed twice within ${CRASH_RECOVERY_WINDOW_MS}ms. ` +
        `AI features will be unavailable until OHD is restarted.`
      );
      return;
    }

    // First crash (or first crash since the recovery window expired) — record
    // and auto-restart.
    this._firstCrashAt = now;
    this._restartCount += 1;
    this._restartInFlight = true;
    logger.warn(`[ai-host] auto-restarting (attempt ${this._restartCount})`);

    // Small delay so we don't hammer if there's an immediate-crash bug.
    setTimeout(() => {
      this._spawn()
        .then(() => {
          logger.info('[ai-host] auto-restart succeeded');
        })
        .catch((err) => {
          logger.logError('[ai-host] auto-restart failed', err);
          this._disabledForSession = true;
        })
        .finally(() => {
          this._restartInFlight = false;
        });
    }, 250);
  }

  _teardown() {
    this._child = null;
    this._ready = false;
    this._readyPromise = null;
    this._initPromise = null;
    this._loadedModels = [];
    this._modelVersions = {};
    this._executionProvider = 'none';
  }

  async _request(kind, payload, opts) {
    if (this._disabledForSession) {
      const err = new Error('ai-inference-host disabled for this session after repeated crashes');
      err.code = 'DISABLED_FOR_SESSION';
      throw err;
    }
    if (!this._ready) {
      await this.init();
    }

    const id = randomUUID();
    const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          const err = new Error(`ai-inference request '${kind}' timed out after ${timeoutMs}ms`);
          err.code = 'TIMEOUT';
          reject(err);
        }
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      const message = { id, kind, ...(payload || {}) };
      try {
        this._child.postMessage(message);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`postMessage to ai-inference-host failed: ${err && err.message}`));
      }
    });
  }
}

module.exports = new AIInferenceClient();
