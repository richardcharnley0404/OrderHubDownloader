# OrderHub Desktop — Add TOPIQ-NR-SPAQ ONNX to complete v1.2.0 AI Quality Gate

## Context

OHD shipped v1.2.0 with milestones M1+M2 of the AI Quality Gate, but the actual scoring model file (`resources/models/musiq/model.onnx`) was deliberately not bundled. Without the file, the orchestrator falls back to score=100 for all images, so the gate is effectively a no-op in production. This task completes the model bundling — but using **TOPIQ-NR-SPAQ instead of MUSIQ-SPAQ**.

**Why the substitution:** MUSIQ-SPAQ has no public ONNX export because its multi-scale preprocessor uses Python-side arithmetic on tensor shapes (`math.ceil`, `round`, `F.unfold` with computed strides) that `torch.onnx` can't trace. Custom export would take 1-2 days of careful surgery. TOPIQ-NR-SPAQ is the closest substitute:

- Statistically tied with MUSIQ-SPAQ on the SPAQ benchmark (~0.917 SRCC on both)
- Trained on the same dataset (SPAQ — smartphone photo quality, ~11k images)
- Uses a ResNet-50 backbone with ImageNet normalization — which matches the contract `musiq-loader.js` already expects
- Exports to ONNX cleanly with no special handling
- Available via `pyiqa.create_metric('topiq_nr-spaq')`, which auto-downloads weights from Hugging Face on first call

The folder name `resources/models/musiq/` stays — it's the slot for the AI quality gate in general, not a hard reference to the MUSIQ algorithm. A code comment in `musiq-loader.js` should make clear what's actually in that slot.

## Required reading before any code changes

Read these files in order, then summarize the existing input contract back to me before proceeding:

1. `docs/phase-1-implementation-plan-ai-quality.md` — the 649-line spec for the AI Quality Gate
2. `src/main/services/ai-inference-models/musiq-loader.js` — the existing model loader (this defines the contract the ONNX file must match)
3. `src/main/services/ai-quality-service.js` — the scoring service
4. `src/main/services/ai-job-quality-orchestrator.js` — the orchestrator
5. `src/main/services/ai-quality-store.js` — the sidecar store
6. `src/main/services/ai-inference-host.js` — the utilityProcess that runs ONNX

After reading, write back a 5-7 line summary of:

- Image dimensions expected (e.g. 384×384)
- Color order (RGB or BGR)
- Where normalization happens — in JS before the ONNX call, or expected to be inside the ONNX graph
- Output type and range (scalar 0-100, scalar 0-1, distribution, etc.)
- Any other contract details (input dtype, batch size, etc.)

**Do not proceed past this step until the contract is unambiguous.** If anything is unclear in the loader code, ask me before guessing.

## Plan

### Phase 1 — Set up isolated Python conversion workspace

Create `tools/onnx-export/` as a new directory at the repo root.

**Add `tools/onnx-export/` to `.gitignore` immediately** — before installing anything. Python deps are ~3GB and pyiqa auto-downloads ~200MB of model weights. None of that should be committed.

Inside `tools/onnx-export/`:

1. Check Python is available: `python --version`. If missing or older than 3.10, install Python 3.11 via `winget install Python.Python.3.11`.
2. Create a virtualenv: `python -m venv .venv`
3. Activate it: `.venv\Scripts\activate`
4. Install pyiqa and onnx tooling:
   ```
   pip install pyiqa onnx onnxruntime
   ```
   This pulls torch (~700MB). Install can take 5-15 minutes on a slow connection. Show the output as it runs so I can see progress.
5. Smoke-test the install:
   ```
   python -c "import pyiqa; m = pyiqa.create_metric('topiq_nr-spaq'); print('ok, weights at', m.net)"
   ```
   The first run downloads weights from Hugging Face (~250MB).

If anything fails — wrong Python version, network issue, dependency conflict — stop and tell me what happened in plain language. Don't try heroic workarounds.

### Phase 2 — Write and run the conversion script

Create `tools/onnx-export/export.py`. The script must:

1. Load `topiq_nr-spaq` via pyiqa
2. Extract the underlying `nn.Module` (typically `metric.net`)
3. **Match the contract from `musiq-loader.js`**: if the loader applies ImageNet normalization in JS, export the model expecting pre-normalized input. If the loader feeds raw [0,1] tensors, wrap the model so normalization happens inside the ONNX graph (use `torchvision.transforms.functional.normalize` mean/std baked in via a wrapper module). The contract you summarized in step 0 dictates which approach to use.
4. Export with `opset_version=17` (compatible with onnxruntime-node 1.20.x, which OHD uses)
5. Use `dynamic_axes` for the batch dimension only — spatial dims are fixed at 384×384 per the contract
6. Save to `tools/onnx-export/model.onnx`

Run the script and report the output file size. Typical TOPIQ-ResNet50 ONNX is ~100MB.

### Phase 3 — Verify the export numerically

Create `tools/onnx-export/verify.py`. The script must:

1. Build a deterministic test input (use `torch.manual_seed(0)` and a random tensor of the right shape, or load a sample image if one exists in OHD test fixtures)
2. Run it through the original PyTorch model (via pyiqa)
3. Run the same input through the exported ONNX (via the `onnxruntime` Python package)
4. Compare the two scores — they **must** match within absolute tolerance `1e-4`
5. If they don't match, investigate. The cause is almost always a preprocessing mismatch: wrong normalization location, wrong color channel order, wrong input range (0-1 vs 0-255), or wrong dtype (float32 vs uint8).

Do not move to Phase 4 until verify.py passes. If it can't be made to pass, stop and explain to me what the discrepancy looks like.

### Phase 4 — Integrate into OHD

1. Copy `tools/onnx-export/model.onnx` to `resources/models/musiq/model.onnx`.

2. Update `src/main/services/ai-inference-models/musiq-loader.js`:
   - **If** TOPIQ's native output is 0-1 and the contract expects 0-100, add a `score * 100` adjustment in the score-extraction step
   - Add a top-of-file comment block:
     ```js
     /**
      * AI Quality Gate model loader.
      *
      * NOTE: this slot currently houses TOPIQ-NR-SPAQ (Chen et al. 2023),
      * exported from the pyiqa toolbox. See tools/onnx-export/ for the
      * conversion pipeline. The folder is named "musiq" for historical
      * reasons; the model is a drop-in substitute statistically tied with
      * MUSIQ-SPAQ on the SPAQ benchmark.
      */
     ```
   - If the loader exposes a `modelVersion` field (used in the sidecar store's `aiQuality` block), set it to `topiq-nr-spaq-v1` so future operator-decision data is tagged correctly.

3. Build OHD locally — check `package.json` scripts; the report says it's `npm run build` plus electron-builder.

4. Run OHD against a real test job. Confirm:
   - The orchestrator no longer returns score=100 for every image (you should see varied scores across the test job's images)
   - The utilityProcess inference host has no errors in the logs
   - Sidecar files (`ai-quality-store.js` outputs) get written with sensible scores and the new `modelVersion`

If you don't have access to a real test job, ask me to point you at a sample folder of images.

### Phase 5 — Report back

Hand back to me:

1. **Contract you settled on** — the 5-line summary from step 0, finalized
2. **Final ONNX file size** and where it lives in the repo
3. **Sample scores table** — pick 5 images from the test job, give each a one-line description ("sharp portrait", "obvious upscale", "blurry phone shot", "compression-killed jpeg", "well-exposed landscape") and the score the model gave. This seeds the calibration conversation.
4. **Any deviations from this plan** and why
5. **Anything that needs follow-up** (e.g. "I noticed `aiQualityEnabled` defaults to false in config; you may want to flip it after calibration")

## Constraints

- **Do not commit `tools/onnx-export/` contents to git.** Only the produced `.onnx` file goes in the repo, via `resources/models/musiq/model.onnx`. The export script and verify script are useful for reproducibility but stay gitignored — copy them to a doc or paste them into a comment if needed.
- **Do not change the AI Quality Gate orchestration.** `ai-quality-service.js`, `ai-job-quality-orchestrator.js`, `ai-quality-store.js`, `ai-inference-host.js` — leave them alone. Only `musiq-loader.js` may need adjustment.
- **Use opset 17 for ONNX export.** onnxruntime-node 1.20.x supports it cleanly; higher opsets may break.
- **Do not change the threshold value.** Threshold calibration is a separate task that needs real production images. Leave whatever value the spec already uses.
- **The user is non-technical.** If you hit a decision point that needs input — "the contract is ambiguous about X, which interpretation should I use?" — stop and ask in plain language. Don't guess and don't run heroic experiments.

## Why this matters

Once this lands, OHD's AI Quality Gate transitions from "always returns 100" to "actually scores images." The sidecar store at `ai-quality-store.js` then starts collecting operator approve/revert decisions on real model outputs. Over the next few weeks of lab operation, those decisions become a labeled dataset — the foundation for any future improvement (better thresholds, custom-trained models, fixup model selection).

The original v1.2.0 design did all the hard infrastructure work. This task is just slotting in the model file the design has been waiting for.
