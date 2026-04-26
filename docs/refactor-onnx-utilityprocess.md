# Refactor — Move ONNX Inference into Electron utilityProcess

**Scope:** Move ONNX model loading and inference out of OHD's main Node.js process into a dedicated Electron `utilityProcess`. Currently affects only PW-007 (Film Scan Auto-Rotation, `orientation-service.js`). After this refactor, both PW-007 and the upcoming AI Quality Gate (and any future AI feature) share one inference host. Behaviour visible to users is unchanged — rotation still works identically.

**Why this exists as its own piece of work:** doing the move once, with one feature in flight (rotation), is cheaper and lower-risk than retrofitting it later when two features depend on the in-main-process pattern. This patch lands between the PW-007 production release and the start of Quality Gate Phase 1 implementation.

**Source of truth:** `ARCHITECTURE.md` and `phase-1-implementation-plan.md` (PW-007). This refactor preserves PW-007's external behaviour 1:1.

---

## 1. Design principles (non-negotiable)

- **No user-visible change.** Film scan rotation works the same way before and after this refactor — same accuracy, same latency profile (within margin), same logs, same Film Review Panel contents, same config schema. If a user notices anything, the refactor failed.
- **One host, many models.** Single `utilityProcess` instance owns all ONNX sessions for the app. Future features add models to the host; they do not spawn new processes.
- **Host failure is recoverable.** If the utility process crashes, the main process auto-restarts it once. If it crashes again within 30 seconds, AI features disable for the session (matching PW-007's existing graceful-failure stance) but the rest of OHD continues running normally.
- **Main process never loads ONNX.** Strictly. After this refactor, no `require('onnxruntime-node')` lives in main-process code. The only place that import exists is inside the host file.
- **Message protocol is typed and minimal.** Don't pass tensors back and forth — pass image paths or buffers and let the host do tensor work locally. Keeps the IPC payload small.

---

## 2. New files

| Path | Purpose |
|------|---------|
| `src/main/services/ai-inference-host.js` | The utilityProcess entry point. Loads ONNX runtime, registers model loaders, exposes a request/response message protocol. Handles its own logging via process stdout (forwarded to Winston by main). |
| `src/main/services/ai-inference-client.js` | Main-process-side client. Spawns and manages the utility process lifecycle. Promise-based public API: `inference.run(modelId, input) → Promise<output>`. Handles restart-on-crash, queues messages while host is starting. |
| `src/main/services/ai-inference-models/orientation-loader.js` | Model-specific loader for the orientation model. Lives main-side as configuration (path, input/output shape, pre/post-processing) but is consumed by the host via the registry. Keeps model-specific logic out of the generic host. |

---

## 3. Files to modify

| Path | Change |
|------|--------|
| `src/main/services/orientation-service.js` (PW-007) | Remove `require('onnxruntime-node')` and all session-loading code. Replace inference calls with `aiInferenceClient.run('orientation', tiffBuffer)`. Public API of orientation-service stays identical — its consumers (folder-watch-service, anything else) need zero changes. |
| `src/main/index.js` | At app startup, initialise `aiInferenceClient` (which spawns the host as a side effect on first use, OR eagerly if the orientation flag is on). Move any current orientation-service-spawn logic accordingly. |
| `src/main/services/logger.js` (or wherever Winston is configured) | Add a forwarder so logs emitted from the utility process (over stdout/stderr or via dedicated message type) land in `logs/app.log` with a `[ai-host]` tag, distinguishable from main-process entries. |
| `package.json` | No new runtime dependencies. `onnxruntime-node` is already there from PW-007. May want to add a small dev-time test helper. |
| `ARCHITECTURE.md` | Update PW-007 section to reflect the new architecture: orientation runs in `utilityProcess`, not main. Add a brief "AI Inference Host" entry under the Service Map. |

---

## 4. Message protocol (main ↔ host)

All messages go through Electron's `utilityProcess` MessagePort. Strictly typed, all payloads JSON-serialisable.

**Request shape (main → host):**

```js
{
  id: 'uuid-string',
  kind: 'inference',
  modelId: 'orientation',  // future: 'musiq', 'fbcnn', etc.
  input: {
    // model-specific. For orientation, e.g.:
    imagePath: '/abs/path/to/image.tif'
    // or for in-memory:
    // imageBuffer: <Buffer>, mimeType: 'image/tiff'
  }
}
```

**Response shape (host → main):**

```js
{
  id: 'uuid-string',  // matches the request
  ok: true,
  result: {
    // model-specific. For orientation:
    predictedClass: 0,
    predictedAngle: 0,
    confidence: 0.987,
    classScores: [0.987, 0.008, 0.003, 0.002],
    inferenceMs: 142
  }
}

// or on failure:

{
  id: 'uuid-string',
  ok: false,
  error: {
    message: 'string',
    code: 'INFERENCE_FAILED' | 'MODEL_NOT_LOADED' | 'BAD_INPUT' | 'OOM'
  }
}
```

**Lifecycle messages:**

- Host → main on startup: `{ kind: 'ready', loadedModels: ['orientation'], executionProvider: 'cpu' | 'directml' }`
- Main → host: `{ kind: 'shutdown' }` for graceful close.

**Logging:**

- Host → main: `{ kind: 'log', level: 'info'|'warn'|'error', message: '...', tag: '[ai-host]' }` — main forwards into Winston.

---

## 5. Lifecycle and error handling

**Spawn timing:**
- Lazy: utility process spawns on the first call to `aiInferenceClient.run(...)`. This means labs with the rotation flag OFF never pay the spawn cost.
- Alternative (if measured spawn time becomes a UX issue): eager-spawn at app startup if any AI feature flag is enabled. Defer this decision until measured.

**Spawn failure:**
- If the utility process fails to spawn, log fatal with `[ai-host]` tag, surface a renderer notification if visible, and disable AI features for the session. Rotation falls back to "no rotation applied" path (already handled by PW-007's graceful failure).

**Crash mid-run:**
- Auto-restart once.
- All in-flight requests (those waiting on a response) reject with `INFERENCE_FAILED`. Their callers handle this as inference failure (PW-007 already does).
- If the host crashes again within 30 seconds of restart, give up: disable AI features for the session, log a single `[ai-host] disabled after repeated crashes` entry.

**Out-of-memory (large image):**
- Host catches OOM signals where possible, returns `code: 'OOM'`. Caller treats as inference failure.

**Shutdown:**
- App quit triggers `{ kind: 'shutdown' }`. Host has 2 seconds to close cleanly. Then it's killed.

---

## 6. Behaviour parity check

The whole point of this refactor is that nothing user-visible changes. Verify by:

| Aspect | Before refactor | After refactor | Pass criterion |
|--------|-----------------|----------------|----------------|
| Rotation accuracy on test fixture set | X% correct | X% correct | Identical predictions on identical inputs |
| Rotation latency per frame | ~Yms | ~Yms ± 20% | No worse than 20% slower (IPC overhead is small but real) |
| `frame-metadata.json` contents | structure A | structure A | Identical fields, identical values for same input |
| Film Review Panel rendering | shows X | shows X | Visually identical, same flag states, same confidence display |
| App startup time (rotation flag ON) | Tms | Tms ± 100ms | Spawn overhead acceptable |
| App startup time (rotation flag OFF) | Tms | Tms | No change (lazy spawn means no ONNX touched) |
| Mode 2 throughput on a 36-frame roll | Rs | Rs | No regression |
| Memory footprint at idle | Mmb | M ± 50mb | Utility process adds RSS, accounted for |
| Behaviour when ONNX model file is missing | graceful disable | graceful disable | Identical user-facing failure mode |

If any of these fail the parity check, the refactor isn't done — fix or revert.

---

## 7. Testing plan

**Unit:**
- Test `aiInferenceClient` against a mock host: queues messages while host is "starting", routes responses by id, restarts on simulated crash.
- Test `orientation-service.js` against a mock client: returns identical results for identical inputs.

**Integration:**
- Spawn the real host with the real orientation model in a test harness. Run a known fixture image through it. Compare result to the pre-refactor implementation's output. Bit-identical predicted class and angle; confidence should be identical to ~5 decimal places (numerical precision of ONNX runtime should not change between in-process and out-of-process).

**Regression (manual):**
- All PW-007 manual smoke tests from `phase-1-implementation-plan.md` Section 11. Each must pass identically.

**Failure injection:**
- Kill the utility process mid-run via Task Manager. Verify auto-restart, in-flight request rejects cleanly, next request succeeds.
- Kill it twice within 30 seconds. Verify "disabled for session" behaviour kicks in.
- Rename the orientation model file before startup. Verify graceful disable, app launches, Mode 2 runs without rotation.

**Performance:**
- Time 100 sequential inferences before vs after. Document the IPC overhead delta.
- If GPU (DirectML) was active before, confirm it's still active after (host should pick up the same EP on the same hardware).

---

## 8. Implementation order

**Step 1.** Add `ai-inference-host.js` skeleton (no model loading yet, just lifecycle and message echo). Add `ai-inference-client.js` that can spawn it, send a `ping`, get a `pong`. Confirm Electron `utilityProcess` works at all in the OHD build environment.

**Step 2.** Add the orientation model loader to the host. Implement the `inference` message handler for orientation. Test with a single fixture image, compare result to direct in-process inference.

**Step 3.** Switch `orientation-service.js` to call the client. Run all PW-007 manual smoke tests. Fix any drift.

**Step 4.** Add the crash/restart behaviour and the corresponding tests.

**Step 5.** Wire up the Winston log forwarding from host to main.

**Step 6.** Update `ARCHITECTURE.md`. Tag a release. Ship.

Each step is small enough to commit and verify independently. If anything goes wrong, revert is one git operation.

---

## 9. What this refactor explicitly does NOT do

- Does not add any new AI features.
- Does not change the orientation model, accuracy, or output format.
- Does not change the Film Review Panel.
- Does not change the orientation feature's settings, config schema, or feature flag.
- Does not change `frame-metadata.json` structure.
- Does not introduce model lazy-download, model versioning, or any infrastructure for future features beyond what the host needs.
- Does not optimise for GPU specifically — same EP selection logic as before, just running in a different process.
- Does not add concurrency capping, queue prioritisation, or batching. Those come with Quality Gate when there's a feature that needs them. The host runs requests serially in this refactor.

---

## 10. Cross-references

- `phase-1-implementation-plan.md` — PW-007 spec; the feature whose internals this refactor changes.
- `phase-1-implementation-plan-ai-quality.md` — Quality Gate spec; the next feature, which assumes this refactor has shipped.
- `ARCHITECTURE.md` — overall OHD architecture; updated as part of Step 6.
