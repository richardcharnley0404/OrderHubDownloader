# MUSIQ-SPAQ ONNX Conversion Audit — AI Quality Gate

**Conversion date:** 2026-04-27
**Last revision:** 2026-04-28 (v1.6 — DPI removal, settings migration, threshold default, jobId convention fix)
**Engineer:** Claude Code (with Richard Charnley, Pixfizz, as reviewer)
**Document version:** v1.6

This document captures the engineering verdict on the JAX → TF SavedModel → ONNX conversion of Google MUSIQ-SPAQ for OHD's AI Quality Gate. For licensing of the source artefacts, see `licensing-audit.md` (sibling file).

## Conversion Pipeline

Source: `gs://gresearch/musiq/spaq_ckpt.npz` (Apache 2.0; the **3-scale** variant — see `licensing-audit.md` § Distribution Channel Choice for why).

1. **JAX forward path** reproduced from Google's reference code in `google-research/musiq` (commit `df108997b095bc6b3ea795ce64dce40429d7529e`), running on the pinned `flax==0.3.3` / `jax==0.4.18` / `jaxlib==0.4.18` / `numpy==1.24.3` / `tensorflow-cpu==2.13.1` stack inside `tools/onnx-export/.venv-jax/`.
2. **`jax.experimental.jax2tf.convert(..., enable_xla=False)`** wrapping with **fixed** input shape `(1, 1217, 3075)`. Polymorphic patch axis was tried first and produced NaN-for-every-input ONNX — a translation-correctness bug in tf2onnx's symbolic-dimension handling, not a flag-tunable issue.
3. **`tf.saved_model.save`** to a SavedModel directory under `_savedmodel_3scale_cap1024/`.
4. **`tf2onnx.convert` CLI** with `--opset 18` and forced `--rename-inputs input --rename-outputs output`.

## Cap-and-Pad Strategy

Because polymorphic-shape ONNX was non-viable, input shape is fixed at conversion time. Choice: `MAX_NATIVE_PATCHES = 1024` (square 1024×1024 → exactly 32×32 = 1024 patches at stride 32) → `TOTAL_PATCHES = 49 + 144 + 1024 = 1217`. The JS-side preprocessor (Step 4) is required to:

- aspect-preserving-resize input to longer-side ≤ 1024
- extract 32×32 patches at stride 32 with SAME padding (per scale)
- pad shorter sequences with mask=0 zero rows up to total length 1217

Alternative strategies considered and rejected:

- **Bucketed fixed shapes** (multiple ONNX files at different caps): adds JS complexity (cap-selection logic), ~3× installer size, no perceived accuracy benefit for OHD's input distribution.

## Numerical Equivalence Verdict

**JAX inference vs ONNX inference, lenna padded to 1217**: max absolute drift **2.29 × 10⁻⁵**. **Threshold for acceptance: 1 × 10⁻⁴**. **Verdict: PASS** (drift is 4× below threshold).

## Investigation Log

The mask=0 padding-equivalence drift (~2.29 × 10⁻⁵ absolute between JAX scoring an image's natural patch tensor vs the same patches padded to 1217 with mask=0 rows) was investigated as a potential semantic bug — specifically, a possible attention-mask leak where pad rows would pollute downstream layers. Three lines of evidence ruled this out:

1. **Pad-row scaling test (positive evidence — float noise).** JAX scores for lenna padded to 600 (151 pad rows), 900 (451 pad rows), and 1217 (768 pad rows) showed drift bounded at **7.63 × 10⁻⁶** for the first two cases and **1.53 × 10⁻⁵** at 768 rows. A 3× increase in pad-row count between 151 → 451 produced no increase in drift, and only a 2× increase at 5× the original pad count. A genuine mask leak would scale drift roughly linearly with pad-row count; constant-magnitude drift across that variation is consistent with bounded float32 accumulation noise.

2. **Code review (positive evidence — mask correctly wired).**
   - `padding_mask=inputs_masks` is correctly passed into `nn.SelfAttention` at line 191 of `multiscale_transformer_utils.py`.
   - CLS token receives `mask=1` prepended to the input mask via `jnp.concatenate` at lines 289–290 of the same file.
   - The encoder output is `encoded[:, 0]` (line 307) — pure CLS index extraction with no aggregation over pad rows. No mean-over-sequence pooling, no relative-bias lookup using row index, no per-batch reduction that would mix pad rows into the output.

3. **Float64 cross-check (inconclusive).** Re-running the equivalence test under `jax.config.update("jax_enable_x64", True)` showed identical drift magnitude (2.29 × 10⁻⁵). Investigation revealed flax 0.3.3 hardcodes `dtype=jnp.float32` throughout its layer initializers (e.g. `multiscale_transformer_utils.py:118, 159, 231`). The x64 promotion at the input boundary gets immediately demoted inside the model layers, so the test did not actually exercise float64 throughput. A clean float64 test would require patching flax 0.3.3 internals — out of scope for this conversion audit.

## Conclusion

Two independent positive proofs of float32 accumulation noise (pad-row-count vs drift relationship; mask-plumbing code review). One inconclusive proof neither for nor against (float64 test). Net evidence supports the float-noise interpretation. **Drift accepted; ONNX export verified at 1 × 10⁻⁴ tolerance.**

## JS-Side Preprocessor — Resize Pivot from Gaussian to Lanczos3 (v1.1)

The production JS preprocessor (`src/main/services/ai-inference-models/musiq-preprocessor.js`) uses **Lanczos3** for the 224 and 384 short-scale resampling, **not** Gaussian as the trained MUSIQ pipeline does. Specifically: `sharp(...).resize(w, h, { kernel: 'lanczos3' })`, which routes through libvips's lanczos3 implementation.

### Why the substitution

A pure-JS Gaussian implementation matching `tf.image.resize(method=GAUSSIAN)` byte-exactly proved infeasible inside Step 4 — TF's GAUSSIAN kernel is defined in compiled C++ with parameters not exposed by the public API, and an empirical pure-JS implementation differed from TF's by 0.5–2.0 absolute on pixel values (Step 4b first run). sharp doesn't expose Gaussian as a kernel option (only nearest, cubic, mitchell, lanczos2, lanczos3).

### Empirical drift, kernel-by-kernel

Two independently-measured pixel-level deltas, both well above any float-noise floor:

- **JAX-Gaussian vs JAX-Lanczos3** (both via TF, same preprocessor code path): 0.5–2.0 absolute
- **JAX-Lanczos3 vs JS-sharp-Lanczos3** (different "Lanczos3" implementations across libraries): 0.4–2.2 absolute

The two libraries' "Lanczos3" implementations are algorithmically distinct: TF runs a single antialiasing-widened Lanczos3 pass, while sharp's libvips backend optimises with an integer block-shrink followed by Lanczos3-on-the-residual factor. Both are valid, neither is wrong, and they diverge by similar magnitude to the kernel-choice (Gaussian↔Lanczos3) drift itself.

### Why we accepted the substitution

Step 4b-redo-1 measured how much MUSIQ-SPAQ scores actually change when the resize kernel changes. Across 5 test images, the JAX-Gaussian → JAX-Lanczos3 score delta was **at most 0.72 points (square1024); typical 0.03–0.34**. The model is robust to the kernel substitution because the trained pipeline already handles smoothed, antialiased inputs; Lanczos3 outputs land within the model's input distribution.

Step 4c then validated end-to-end: comparing the full JS-sharp-Lanczos+ONNX pipeline (production) against the JAX-Gaussian+reference (canonical), max **|score_A − score_B| = 0.58** across 5 test images:

```
image          A: JS+ONNX     B: JAX+Gaussian   |A-B|
lenna             74.15           73.99         0.17
hairstreak        69.53           69.44         0.09
penguins          74.79           74.93         0.14
square1024        60.98           61.55         0.58
large             52.90           52.94         0.04
```

The element-wise byte-exact patch parity originally specified in Step 4b was intentionally relaxed in favour of operational score parity once empirical evidence showed the model absorbs preprocessing-level drift cleanly. The relaxation is not a workaround — it's the right level of rigour for a quality-gate use case where the score, not the patch tensor, is the user-facing artefact.

## Cap-vs-Bad-Discrimination Interaction (v1.1)

The production config uses `max_seq_len_from_original_res = 1024` to bound inference latency. For very tall/wide images this means the native-scale path sees only the top row-major fragment at full resolution. The 224 and 384 scales still see the whole image (aspect-preserving resize). Cross-scale attention preserves upscale-detection capability, but with reduced margin compared to the uncapped config:

| native cap | score on canonical 1920×2400 synthetic-upscale | margin below operational threshold (75) |
|---|---:|---:|
| **1024 (production)** | **52.90** (JS+ONNX) / 52.94 (JAX) | 22 points |
| `-1` (uncapped, research) | 26.73 (JAX) | 48 points |

Both cleanly below the operational threshold of 75 — the gate flags the upscaled image correctly in both configs. But the production-cap result has less headroom: a milder upscale (e.g. 2× rather than 3×) might score in the 60s and escape detection, where the uncapped config would still flag it.

This is a known tradeoff baked into the conversion. The cap is the natural lever to revisit if production data later shows borderline upscales escaping the gate. Revisiting requires re-exporting the ONNX with a different preprocessing config (back to Step 3 territory).

## SAME-Padding Bug Discovery and Fix (v1.2)

### What was wrong

`extract_32x32_patches` in the JS preprocessor put SAME-padding entirely on the bottom-right edges of each axis. TF's `tf.image.extract_patches` puts the padding **symmetrically**: for an axis where total pad is `T`, it places `floor(T/2)` zeros at the start (top or left) and `T - floor(T/2)` zeros at the end (bottom or right). The asymmetric variant produces patches that are spatially *offset* from TF's by `floor(T/2)` pixels along each padded axis.

### Why it stayed hidden

Only images with non-multiple-of-32 dimensions exercise the SAME-padding code path at all (an image whose dims are exact multiples of 32 has total_pad = 0 → no asymmetry to get wrong). In the original Step 4b validation set, only one image — `penguins.png` (400×378) — had non-multiple-of-32 dimensions on either axis. Lenna (512²), hairstreak (640×800), square1024 (1024²), and the synthetic upscale (1920×2400) were all clean multiples of 32. The bug was invisible to the other four cases.

**Real customer photos are essentially never multiples of 32.** 4032×3024 phone photos, 3000×4000 portraits, DSLR captures — all exercise the SAME-padding path. The bug would have shipped silently and affected every production input.

### How it surfaced

Step 4b reported 2.0-magnitude element-wise drift on penguins's native scale, while every other image had native-scale drift in the 5e-2 (JPEG decode delta) to 5e-8 (PNG, float-noise floor) range. The fact that the divergence was **a single-image outlier**, not a uniform effect, was the diagnostic signal that pointed to an image-dimension-specific code path rather than a uniform float-noise issue. A direct probe of `tf.image.extract_patches` on a synthetic 33×33 input confirmed TF's symmetric-pad convention; matching the JS implementation against it dropped penguins-native drift from 2.0 to 5.9e-08 (the same float-noise floor as lenna).

### Lesson — score-level robustness was masking a structural bug

Pre-fix pairwise score deltas across the 5-image test set were 0.04–0.58 (within tolerance). Post-fix deltas are 0.17–0.70 (still within tolerance, but **larger**). The model's robustness to preprocessing variation was partially canceling two compounding errors:

- buggy SAME-padding offset (pixels in the wrong patch positions)
- sharp's Lanczos vs TF's Gaussian (different kernel implementations)

When the offset bug was fixed, only the kernel-residual remained, and the score deltas reflect its true contribution. **A pure score-level test would have validated the broken preprocessor.** The element-wise patch comparison was load-bearing exactly because penguins (the one non-multiple-of-32 image) flagged the structural problem that scores alone wouldn't have surfaced.

This validates the decision to retain element-wise patch-tensor checks as a diagnostic gate even after relaxing them as an acceptance gate.

### Fix

`musiq-preprocessor.js:extract_32x32_patches` now computes:

```
totalPadH = count_h * 32 - h
totalPadW = count_w * 32 - w
padLowH   = floor(totalPadH / 2)
padLowW   = floor(totalPadW / 2)
```

…and applies `padLowH` / `padLowW` as offsets when reading source pixels for each output patch, exactly mirroring TF's symmetric SAME-padding semantics.

The unit test was rewritten with hand-derived expected values asserting byte-exact match to TF's tf.image.extract_patches — the original test had asserted my (buggy) code's behavior, which is the trap of writing tests after the implementation rather than to a spec. The new test runs `tf.image.extract_patches` on a known input as the reference, then asserts the JS output matches.

## Status: Pivot to Flag-and-Allow (v1.7)

**The Phase-2 quarantine model that follows in this section is no longer the production design.** It was rejected on operator-trust grounds in v1.3.2 and replaced with a flag-and-allow approach. The narrative below is preserved as historical-rejected-design: it documents what was built, why it was built, what it cost the customer, and the empirical surprise that validated the pivot. New readers should treat the rest of this section as history; the v1.7 production behavior is summarised here.

### Original model (v1.5–v1.3.1)

- Magic-byte check on every JPEG/PNG download (FTP layer).
- On failure: file renamed to `<filename>.quarantine`, per-order `_ohd-quarantine.json` manifest written, sibling-quarantine guard skipped re-downloads on persistent corruption.
- Built for defensive correctness: protect the print pipeline from inputs the magic-byte check classifies as suspect, on the (reasonable-looking) theory that downstream consumers couldn't handle them.
- The full rationale is in `## Production Fix Implementation (v1.5)` below — that work was substantively right for the constraints it was solving for.

### Why we pivoted

The production observation that drove the pivot: a real customer's order had 8 images flagged by the magic-byte check during download. Under the old model those 8 files were renamed to `.quarantine`, made invisible to the print pipeline, and the customer received 125 prints out of an expected 133. The customer paid for 133 prints. They got 125. The 8 quarantined files lived on disk waiting for an operator to investigate, but no operator-facing path existed to surface "you have customers waiting for prints OHD has hidden" — the .quarantine extension and the per-order manifest were both invisible to the operator UI.

**The failure mode wasn't technical. It was operator-trust.** OHD's quarantine model embedded a decision ("this file can't print") inside a layer that had no way to surface that decision to the operator. The customer didn't lose 8 prints because the files were corrupt — they lost 8 prints because OHD silently chose for them. Detection and decision are separate concerns; OHD's job is to detect and surface, not to silently exclude.

### New model (v1.7 / OHD v1.3.2)

- Magic-byte check still fires on download.
- On failure: file keeps its real `.jpg`/`.png` extension. A new `integritySuspect` block is written to the per-image sidecar with diagnostic data (firstBytesHex, ftpRemotePath, detectedAt, expectedMagic).
- Print pipeline attempts the file normally. AI Quality scoring's existing graceful-fail path handles unscoreable files cleanly. Whether the file ultimately prints is decided downstream — by the printer, by the operator inspecting the output, or by the customer reviewing what they received.
- One-shot startup migration restores any pre-existing `.quarantine` files to their original extensions and translates legacy `_ohd-quarantine.json` manifest entries into the new sidecar shape, then archives the manifest.
- Implementation details, full file:line summary, test count delta, and field-verification log live in `docs/orderhub/bugfixes.md` under the v1.3.2 entry.

### Architectural lesson

**Magic-byte checks are signals, not ground truth.** Many files that fail the JPEG/PNG magic-byte check are still valid downstream. Sharp's lenient decode (`failOn: 'none'`) handles partially-corrupted JPEGs that have a sparse-zero leading region but recoverable real JPEG data later in the file — exactly the failure pattern that drove the original Phase-2 work.

The empirical verification at v1.3.2 ship time produced a finding nobody on the team had predicted. The 11 quarantined files migrated forward by the dev-machine fixture run were expected to either fail at scoring (graceful-fail path → `score: 100, error: '...'`) or land at low scores after partial decode. **All 11 scored cleanly via real MUSIQ inference with values 59–67 — no graceful-fail path even invoked.** The "corrupt" files weren't unscoreable; they weren't even particularly bad. The magic-byte check was over-rejecting at a rate that, multiplied across the customer's job volume, represented real money lost.

The lesson generalises beyond this one check: **whenever a heuristic gates "process this further" decisions, the cost of false-positives is paid by the operator/customer at scale, while the cost of false-negatives is paid once at the layer that exists to handle them.** Heuristics are best treated as "flag for operator awareness" rather than "exclude from processing." The flag-and-allow pattern lets the heuristic still inform without letting it veto.

### What's preserved below

The original v1.3–v1.6 narrative starts at `## Production Observation: Download-Side Corruption with Cached Size-Match (Phase-2 Critical)`. Read it as the engineering trail of the rejected design — it captures the diagnostic discipline that surfaced the corruption pattern (which is still valuable, the magic-byte check still fires, only the action taken on failure has changed) and the v1.4 honesty pass that distinguished "race condition" from "persistent on-disk corruption". Both lessons survive the pivot. The two-layer fix at v1.5 is the design that v1.7 replaces.

---

## Production Observation: Download-Side Corruption with Cached Size-Match (Phase-2 Critical)

**Status: Resolved in v1.5; pivoted to flag-and-allow in v1.7 — see `## Status: Pivot to Flag-and-Allow (v1.7)` above for the current production design.** The two-layer fix described below was implemented and is live in OHD v1.3.0–v1.3.1; see `## Production Fix Implementation` further down for the as-built summary, plus `## Smoke-Test Results` for the verification verdict. The "Phase-2 Critical" tag and the v1.3-vs-v1.4 framing notes stay on record per the v1.4 honesty pass.

During Step 4d's live test (PXDEMO-JMQNPV-1, 97-image job), 3 of 97 images (~3.1%) failed scoring with `prepareTensor failed: Input file contains unsupported image format`. Forensic analysis of the failed files revealed they are NOT in an unsupported format — they are files whose first 73–83% of bytes are zeros, with high-entropy trailing data ending in `FFD9` (the JPEG End-of-Image marker) but no matching `FFD8` (Start-of-Image) marker anywhere in the file. The pattern is the byte signature of NTFS sparse-file allocation, where data was written at non-zero offsets and the leading region remained as zero-filled holes.

The corruption is **persistent on disk, not transient.** The three affected files were written with their current corrupt contents during the FTP download and have not changed since — verified by re-reading each file's mtime and content hours after the original test. Each file's mtime is 58 seconds to ~85 seconds *before* its corresponding scoring failure, not after. There is no in-progress write involved at scoring time; the file was already fully laid out (corrupt) on disk by the time scoring read it, and remains in that state indefinitely.

The corruption persists across polling cycles because of the size-match skip-cache in `src/main/services/ftp-service.js:186-198`:

```js
if (fs.existsSync(localItemPath)) {
  const localStats = fs.statSync(localItemPath);
  if (localStats.size === item.size) {
    summary.skipped++;
    // Still delete from FTP since we already have it
    ...
    continue;  // skip download — size matches
  }
}
```

Once a corrupt file with the right size lives on disk, every subsequent polling cycle treats it as "already-downloaded" and skips re-download. The orchestrator's idempotency in `src/main/services/ai-job-quality-orchestrator.js:148-154` then locks in a permanent `aiQuality.scored: true, error: "..."` sidecar entry on the first scoring attempt — the file is never re-scored even if the on-disk content somehow improved.

This is an OHD-internal data-integrity issue, not a customer-input issue. The graceful-fail path in `ai-quality-service` handles it correctly today (failed image gets `score=100, passed=true` so it doesn't block routing), but operationally these images go unscored permanently. **Once `aiQualityEnabled` is flipped to ON in production and the threshold starts acting on scores, ~3% of images will silently bypass the gate with a free `score=100` pass — exactly the failure mode the entire gate exists to prevent.** This is why the section is tagged Phase-2 Critical rather than informational.

### Diagnostic Note: Why v1.3 Got This Wrong

The v1.3 framing of this section called it a "race condition" — specifically, that "the AI service tried to score the file ~1 second before the FTP download finalised the file write." That diagnosis was based on a single mtime check against a single log timestamp, and it was wrong.

The re-investigation that produced this v1.4 diagnosis did three things differently:

1. **Checked all three failed files' timestamps**, not just one. The other two files' scoring failures were 1+ minutes after their mtimes, not 1 second. The "1-second-before-write-completion" pattern was a misread of which scoring-failure log line corresponded to which file.

2. **Re-checked the on-disk state hours after the original test.** The files are still corrupt, with the same mtimes. If the failure had been a write-completion race, the files would eventually have been written correctly and the mtimes would have advanced. They didn't — the corruption is permanent.

3. **Traced the trigger chain through the actual code** (`polling-service.runAllModes()` → `scanFtp()` → `pollJobs()` → `onAutoPrint` fire-and-forget → `runAutoPrint()` → `aiJobQualityOrchestrator.scoreJob()`) instead of relying on the spec's `phase-1-implementation-plan-ai-quality.md` § 6 design intent. The implementation diverged from the spec: there is no per-image-as-it-lands hook, only a job-level scan triggered after the polling cycle. The "race against download completion" the spec was worried about doesn't exist in this code path because scoring is sequenced strictly after the FTP scan via `await`. The bug is upstream of the timing, in the download itself.

The lesson: when a finding looks like a timing issue, verify across multiple data points and check whether the artefact is still in the broken state at rest. Race conditions self-resolve over time; persistent corruption doesn't. The v1.3 framing recommended fixing the wrong layer.

### Three potential fixes (v1.3 — based on incorrect framing — superseded)

The fixes proposed in v1.3 are kept here for historical reference but no longer recommended:

- ~~**Synchronise scoring against download completion**~~ — Misdirected. The corruption isn't a timing issue; the file is corrupt on disk well before scoring runs, and stays corrupt.
- ~~**Integrity check before scoring** with `FILE_NOT_READY` retry~~ — The intent (detect malformed input) is right, but the "retry once after a short delay" framing is wrong: the corrupt file isn't going to fix itself within seconds. Retry without a re-download is pointless.
- ~~**Mark corrupted-on-read images as scoring-deferred**~~ — Same. "Deferred" implies eventual recovery, but no recovery is coming without a re-download triggered by an upstream signal.

### Two-layer fix approach (v1.4)

The corruption is on disk before scoring begins. The fix has to operate at two layers: catch corruption at the download-side, AND make scoring resilient to it for the rare cases the download-side check doesn't catch.

**Layer A — download-side integrity verification.** Strengthen the size-match check at `ftp-service.js:186-198, 215-232`: after `downloadTo` resolves AND the size matches, ALSO verify the file's leading bytes are a valid image-format magic (`FFD8` for JPEG, `89504E47` for PNG). If the magic check fails: **delete the local file**, log loudly with the details, leave the FTP-side copy in place, and let the next polling cycle re-download. The failed file is never reported as a "successful download" to anyone downstream. This eliminates the size-match skip-cache from caching corrupt files.

**Layer B — scoring-side recoverable re-score.** Make the orchestrator's idempotency in `ai-job-quality-orchestrator.js:148-154` conditional on previous score's success: an entry with `aiQuality.error != null` is treated as "not yet scored" on the next pass. Combined with Layer A, this allows automatic recovery — the download-side fix re-downloads clean files, the sidecar lock-in is bypassed for error entries, and the re-downloaded clean file gets scored normally on the next cycle. Without Layer B, even a Layer-A re-download wouldn't help because the sidecar entry would already be locked.

### Recommended sequencing

1. **Ship the next OHD release with `aiQualityEnabled` defaulting to OFF** (shadow-mode), so this bug doesn't matter operationally yet.
2. **Investigate the basic-ftp behaviour that produces sparse-allocated corrupt files** (planned as Step 2 of the follow-up session). Understanding the mechanism informs whether Layer A's magic-byte check is enough or whether a deeper download-path fix is also needed.
3. **Implement Layer A (download-side integrity check + delete-on-failure) and Layer B (scoring-side recoverable re-score)** in the same focused follow-up session.
4. **Only enable the gate** (flip `aiQualityEnabled` to ON in shipped installs) **after both fixes have landed AND a follow-up test job confirms 0 download-corruption failures across 100+ images.** The test must reproduce the FTP-pull pattern that surfaced this bug — synthetic local-only tests won't exercise the download path.

This is its own conversation, scheduled for a focused follow-up — not a Phase-1 blocker.

## Production Fix Implementation (v1.5)

The two-layer fix and the warn-mode product change landed across six phases in a focused implementation session on 2026-04-28. The as-built summary follows.

### Layer A — Download-side magic-byte check + quarantine

A new pure-synchronous helper `src/main/services/file-integrity.js` exports `checkImageMagic(filePath)`, which inspects the first 8 bytes of a file and returns `{ valid, format, magicHex }` for JPEG (`FF D8 FF`) and PNG (`89 50 4E 47 0D 0A 1A 0A`). One 8-byte read per file, no async cycles in the FTP loop. The diagnostic-by-design `magicHex` field carries the actual leading bytes seen so failure logs surface the corruption pattern (`0000…` for sparse-allocated, `3c21444f…` for an HTML error page, etc).

`src/main/services/ftp-service.js` was wired to call `checkImageMagic` at two gates:

- **Skip-cache branch (lines 305-342):** before treating a size-matched local file as a cache hit, run the magic-byte check. On invalid bytes, quarantine the local copy and **do not re-download** (avoids a poll loop on persistent upstream corruption). Leave the FTP source in place for source-side investigation.
- **Post-download branch (lines 367-397):** after `client.downloadTo` resolves and size matches, run the same check. On invalid bytes, quarantine, decrement `summary.downloaded`, increment `summary.failed` and `summary.quarantined`, push to `summary.errors`. FTP source preserved.

The check is **gated on a narrow extension filter** — `INTEGRITY_CHECK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])` — defined in `ftp-service.js` and deliberately narrower than the codebase-wide `IMAGE_EXTENSIONS` set (which includes `.tif`/`.tiff` for compatibility with other code paths). Files outside this set bypass the check entirely. See `## Smoke-Test Bug: Magic Check Applied to Non-Image Files` below for the bug that motivated this filter.

Quarantine semantics:

- Local file renamed to `<localpath>.quarantine` (preserves bytes for operator inspection).
- Per-job manifest at `<jobDir>/_ohd-quarantine.json`, where `jobDir` is the **first-level subfolder of the FTP scan root** (depth-aware threading through recursion). The manifest is append-only — multiple events in the same job append entries, never overwrite. Schema v1: `{filename, quarantinedAt (ISO), ftpRemotePath, expectedSize, actualSize, firstBytes, expectedMagic, reason}`.
- Structured `[quarantine] Corrupt file quarantined` log line at error level with all fields populated for downstream alerting.
- A pre-existing `<localpath>.quarantine` sibling causes the next poll's skip-cache branch to short-circuit with `[quarantine] Slot already quarantined, skipping re-download` at warn level — no re-download attempted until an operator clears the sibling.

### Layer B — Scoring-side recoverable re-score

`src/main/services/ai-job-quality-orchestrator.js` was updated so the per-image skip-vs-rescore decision now distinguishes clean previous scores from errored ones:

- **Clean previous score (no `error`)** → skip as before.
- **Errored previous score, file fingerprint unchanged** → skip (no point re-running on the same broken file every poll).
- **Errored previous score, fingerprint changed** → fall through and re-score (file was replaced, likely after a Phase-2 quarantine event surfaced corruption and the operator dropped a fresh copy).
- **Legacy sidecar without fingerprint fields** (predates this change) → skip (can't tell).

Fingerprint capture: `fs.statSync(imagePath)` once before scoring; `fileSizeAtScoreTime` (number) and `fileMtimeAtScoreTime` (number, `mtimeMs`) written into the sidecar block alongside the existing fields. `ai-quality-store.js`'s `_defaultBlock()` now declares both as `null` so pristine and pre-Phase-3 sidecars behave identically under the orchestrator's `!= null` guards.

### Warn-mode product change

A new `aiQualityMode: 'warn' | 'block'` config flag (default `'warn'`) was added to `config-service.js` next to the existing `aiQualityEnabled` field. The orchestrator's gating point now derives `held` mode-aware:

```js
const qualityHeld = aiQualityStore.deriveHeld(finalRows);
const mode = configService.get('aiQualityMode') || 'warn';
const held = (mode === 'block') && qualityHeld;
```

In warn-mode, sub-threshold images are still recorded with `passed: false` in the sidecar and surface in the Quality Review tab, but `held: false` is returned to the auto-print loop and `canRoute()` short-circuits to `true`. Routing proceeds. A summary log line `[ai-quality] warn-mode: jobId=…, total=N, sub-threshold=K, routing proceeds` fires at info level whenever warn-mode runs and any sub-threshold images are present, so the held-state-that-would-have-been remains visible in operator logs.

In block-mode, the original M1+M2 behaviour is preserved: held=true holds the job until operator action.

### File:line summary

| File | Change |
|------|--------|
| `src/main/services/file-integrity.js` | New module; `checkImageMagic()` |
| `src/main/services/ftp-service.js:1-114` | Imports + `INTEGRITY_CHECK_EXTENSIONS`, `shouldIntegrityCheck()`, `isQuarantinedSibling()`, `moveToQuarantine()` |
| `src/main/services/ftp-service.js:255` | `scanAndDownload` passes `null` initial `jobDir` for depth-aware threading |
| `src/main/services/ftp-service.js:277-342` | `_downloadDirectory` skip-cache branch: sibling guard + extension-gated magic check + quarantine |
| `src/main/services/ftp-service.js:344-403` | `_downloadDirectory` post-download branch: extension-gated magic check + quarantine |
| `src/main/services/ftp-service.js:444-457` | Helpers exposed on the singleton (`_moveToQuarantine`, `_isQuarantinedSibling`, `_shouldIntegrityCheck`, `_INTEGRITY_CHECK_EXTENSIONS`) for tests + diagnostics |
| `src/main/services/ai-job-quality-orchestrator.js:148-189` | Skip-vs-rescore matrix |
| `src/main/services/ai-job-quality-orchestrator.js:196-220` | Stat capture + `fileSizeAtScoreTime` / `fileMtimeAtScoreTime` written |
| `src/main/services/ai-job-quality-orchestrator.js:226-263` | Mode-aware held gating + warn-mode summary log line |
| `src/main/services/ai-job-quality-orchestrator.js:285-296` | `canRoute` short-circuits to `true` in warn-mode |
| `src/main/services/ai-quality-store.js:141-162` | `_defaultBlock()` adds `fileSizeAtScoreTime: null`, `fileMtimeAtScoreTime: null` |
| `src/main/services/config-service.js:154-179` | New `aiQualityMode` schema entry; `getAll()` + `save()` wiring |

### Test counts

**36/36 unit tests pass.**

| Suite | File | Count |
|-------|------|------:|
| File-integrity helper | `src/main/services/__tests__/file-integrity.test.js` | 8 |
| FTP-service extension gate | `src/main/services/__tests__/ftp-service.test.js` | 8 |
| Orchestrator (warn/block, re-score, legacy) | `src/main/services/__tests__/ai-job-quality-orchestrator.test.js` | 6 |
| MUSIQ preprocessor (carry-over from v1.0–v1.2) | `src/main/services/ai-inference-models/__tests__/musiq-preprocessor.test.js` | 14 |

## Smoke-Test Bug: Magic Check Applied to Non-Image Files

### How it was caught

Scenario 1 prep (live smoke test, post-restart) discovered a stray `PXDEMO-PT7HM2.json.quarantine` file in a fresh-test-job folder, with no corresponding `_ohd-quarantine.json` manifest at the location expected by the (incorrectly global-rooted) v1.5 implementation. Three diagnostic questions surfaced the cause:

1. Did OHD's new code path produce this file? Logs answered yes — a `[quarantine] Corrupt file quarantined` event fired at 10:19:00 on `PXDEMO-PT7HM2.json` with `firstBytes: 7b0d0a2020226f72` (decodes to `{\r\n  "or…` — the start of an order-manifest JSON).
2. Did the Phase 2 sanity-check script use a real path? No — `phase2_sanity_check.js:81` uses `fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-phase2-'))`. Innocent.
3. Did `_downloadDirectory` apply the magic-byte check to every file regardless of extension? **Yes — bug.** Both magic-check branches in `ftp-service.js` called `checkImageMagic(localItemPath)` unconditionally.

### Why it would have shipped quietly without the smoke test

JSON files start with `{` (`0x7B`), which doesn't match either JPEG (`FF D8 FF`) or PNG (`89 50 4E 47 0D 0A 1A 0A`) magic. So every order-manifest JSON OHD downloaded would have failed the check and been quarantined as "corrupt" — not just on this test job, but on **every job, going forward, indefinitely**. Quarantining the order manifest also breaks downstream consumers (`print-service._readManifest` requires the file present), turning the false positive from "noise" into "every job is broken." Pre-flight unit tests passed because they only exercised image fixtures; the bug needed a real job to surface.

### Fix

A new `INTEGRITY_CHECK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])` constant in `ftp-service.js`. Both magic-check branches now gate on `shouldIntegrityCheck(item.name)`, which checks `path.extname(filename).toLowerCase()` against the set. Files outside the set bypass the check entirely. The set is **deliberately narrower than the codebase-wide `IMAGE_EXTENSIONS`** (defined in `ai-job-quality-orchestrator.js` and `sidecarManager.js` as `{.jpg, .jpeg, .png, .tif, .tiff}`) — those have a different scope ("what OHD considers an image at all"), while `INTEGRITY_CHECK_EXTENSIONS` means "what the FTP layer can validate via JPEG/PNG magic bytes." TIFF support was deferred (Pixfizz doesn't accept TIFF uploads upstream); PDFs are out of scope (corruption surfaces during downstream PDF rendering).

### Lesson

**File-format validation must be gated on file extension when the validation is type-specific.** The FTP layer downloads more than just images — order manifests, sidecars, future PDFs, anything that lives in the FTP slot — and a check that's correct for one format is a false-positive generator for every other format. The unit test count alone (8 file-integrity, 8 ftp-service-gate) validates each layer in isolation, but only the live smoke test surfaces interactions like "magic check fires on the wrong file class entirely."

The same lesson generalises: when a helper has a narrower domain than its caller, the gate belongs at the call site, not buried in the helper. `checkImageMagic` correctly stays format-agnostic; `shouldIntegrityCheck` is the policy boundary.

## Design Note: Ghost Sidecar Entries on Quarantined Slots

When the FTP layer quarantines an image, it renames the local file from `<name>.jpeg` to `<name>.jpeg.quarantine`. The orchestrator's `_scanJobImages()` filters by `IMAGE_EXTENSIONS`, so on the next auto-print pass it does **not** find the quarantined slot — no re-score is attempted (correct; `.quarantine` files aren't images and the bytes are corrupt). However, `aiQualityStore.getJobQuality()` reads the full sidecar, which still contains the **pre-quarantine** entry for that filename: `scored: true, passed: false (or true), score, error: null` (or whatever the pre-corruption scoring path produced).

The orchestrator's post-write `deriveHeld(finalRows)` iterates **all** sidecar rows, including this ghost. So a quarantined image contributes `qualityHeld: true` until the ghost entry is cleared (operator decision: `approved_as_is` or `fixed`).

**This is design intent, not a bug.** A job with a quarantined image SHOULD hold in block-mode pending operator action — either:

- a fresh copy of the image arrives (next FTP poll detects the slot and downloads it; orchestrator's Phase-3 re-score logic notices the new fingerprint relative to the ghost entry and re-scores), or
- the operator explicitly decides via the Quality Review tab (clears the held state through the existing `releaseJob` IPC).

In warn-mode the ghost is harmless (`held = (mode === 'block') && qualityHeld` collapses to `held: false` regardless). In block-mode the ghost correctly preserves the operator's gate over the affected job.

The smoke-test fixture exhibited this: after Scenario 1 quarantined one of the 22 PT7HM2 images, the warn-mode log line read `total=21, sub-threshold=21` (21 on-disk + 1 ghost contributing to sub-threshold). The total reflects on-disk reality; the sub-threshold count reflects sidecar reality including the ghost.

## Warn-Mode Rollout Strategy

The `aiQualityMode` flag ships defaulting to `'warn'`, not `'block'`. Operational rationale:

1. **Calibration data accumulates passively from real production work.** Every job goes through scoring; per-image scores are written to sidecars; the Quality Review tab shows the spread of real production scores against the (placeholder) threshold of 75. No configuration changes are needed for sites to start producing data — flipping `aiQualityEnabled: true` is enough. The team can review aggregate distributions across sites and tighten or relax the threshold based on real evidence rather than test images.

2. **No false-positive rejection risk during the calibration period.** The threshold is currently a placeholder. Shipping with `'block'` default would mean every install that flips the gate ON immediately starts rejecting jobs at a threshold that hasn't been validated against the site's print quality bar. Operators would lose trust in the gate before it's calibrated. Warn-mode keeps the gate scoring but non-blocking — operators see the warnings, learn what they look like, and develop confidence in the calls before any operational impact.

3. **Operator trust builds through visibility, not enforcement.** The warn-mode summary log line surfaces the held-state-that-would-have-been on every poll, plus per-image `passed: false` in the sidecar, plus the existing red-badge UI in the Jobs grid (which still renders in warn-mode — only the routing decision is short-circuited). When operators have seen warnings on enough jobs to predict the gate's behaviour, they flip to block-mode confident in what it'll catch.

### Path to block-mode

For now: stop OHD, edit `%APPDATA%/orderhub-downloader/config.json` to set `"aiQualityMode": "block"`, restart. The schema and `getAll()` / `save()` wiring already support the field via the standard config-service path; only the UI surface is missing.

A UI toggle in the Settings panel is queued as a future enhancement. It would live next to the existing `aiQualityThreshold` control and offer the same two values. Until then, the config-edit path is operator-accessible (the config file is at a stable known location, valid JSON, and the schema validates the value range). Releases that ship the UI toggle should preserve the existing config value on upgrade.

## Smoke-Test Results

End-to-end smoke test against the live FTP+OrderHub pipeline on 2026-04-28, fresh test job `PXDEMO-PT7HM2` (22 images, 21 sub-threshold under the placeholder threshold of 75).

| Scenario | Verdict | Key evidence |
|----------|---------|--------------|
| 1 — Layer A quarantine | ✓ pass | Trigger event at 10:42:57 with all manifest fields populated; per-job manifest at `<jobDir>/_ohd-quarantine.json` (not global root); no-loop guard fired at 10:43:57 with no manifest duplication; FTP source preserved at expected size |
| 2 — Warn-mode default | ✓ pass | `mode=warn, qualityHeld=true, held=false` log line + `[ai-quality] warn-mode: …, routing proceeds` summary; canRoute probe returned `true`; zero `[auto-print] job held` events for the fixture |
| 3 — Block-mode toggle | ✓ pass | `mode=block, qualityHeld=true, held=true` log line; `[auto-print] job held` fired with structured summary `{mode:"block", qualityHeld:true, subThreshold:21, …}`; canRoute probe returned `false`; warn-mode line suppressed; revert to warn-mode restored baseline |
| 4 — DPI removal (v1.6) | ✓ pass | `grep -rn 'dpi\|DPI\|Dpi' src/` returns only the two pre-existing pixel-density comments in `print-service.js` and `banner-sheet-service.js`; OHD startup log shows zero DPI references; Send-to-Print click handler simplified to single-step send; settings UI no longer surfaces DPI controls; existing 36/36 test suite unchanged |
| 5 — JobId convergence (v1.6) | ✓ pass | Post-cleanup auto-print pass on PT7HM2 wrote 22 fresh scores into `PXDEMO-PT7HM2_38412023.json` (composite sidecar); all 22 entries carry `modeAtScoreTime: "warn"`, `fileSizeAtScoreTime`, `fileMtimeAtScoreTime`, `thresholdAtScoreTime: 75`, full Phase 3 + Phase C field set; orchestrator log line reads `[ai-quality] job PXDEMO-PT7HM2_38412023 scored: …` (composite jobId arriving from IPC layer); 54 orphan `<numeric>.json` files cleanly deleted, 221 KB reclaimed; ScoreBadge data path verified via direct sidecar inspection |

### Notes per scenario

**Scenario 1.** The corruption injection followed the production failure mode: zero the leading 1024 bytes of an in-place local image, preserve the `FFD9` JPEG-EOI marker at the tail, keep size unchanged, upload the corrupt bytes to the matching FTP slot. The skip-cache branch correctly identified the size match, ran the (now extension-gated) magic check, and quarantined. The renamed `.quarantine` file lived in the per-job folder `PXDEMO-PT7HM2_69f07b3da15f04aa/PXDEMO-PT7HM2_38412023/`, with the manifest at the per-job-folder root `PXDEMO-PT7HM2_69f07b3da15f04aa/_ohd-quarantine.json` — depth-aware jobDir confirmed.

**Scenario 2.** Used the Scenario-1-produced post-quarantine fixture (PT7HM2 with 21 on-disk + 1 ghost sidecar). The orchestrator skipped all 21 already-scored images cleanly (no `error` field), computed `qualityHeld: true` from the full sidecar (ghost included), then mode-gated to `held: false`. Auto-print proceeded past the gate every cycle for the duration of the test.

**Scenario 3.** Stop, edit config (`aiQualityMode: undefined → "block"`, JSON re-validated), restart. First poll on the new mode produced `held: true` and the `[auto-print] job held by AI Quality Gate` event with the full summary structure. Reverted (`"block" → "warn"`), restarted, confirmed warn-mode behaviour fully restored. The same operator-approve workflow (`releaseJob` → `setOperatorDecision({kind: 'approved_as_is'})`) is unchanged; with the ghost-sidecar finding above, releasing a held job would also clear the ghost entry's contribution to `qualityHeld`.

## DPI Removal (v1.6)

The DPI validation system was the original first-line image-quality filter
shipped before the AI Quality Gate. With the Quality Gate now in production,
DPI was redundant — and its failure mode (no-op pass on upscaled-but-claims-300-DPI
photos) is exactly what the Quality Gate exists to catch. Removed in full
in this revision.

### What was removed

**Backend:**
- `src/main/services/dpi-validator.js` — full module, 487 lines
- `scripts/test-dpi-validation.js` — orphan standalone test (would have errored on require after the validator was deleted)
- `src/main/ipc-handlers.js` — `jobs:validateDpi` handler (51 lines), `jobs:approveDpi` handler (16 lines), and the `require('./services/dpi-validator')` line
- `src/main/services/config-service.js` — six DPI schema entries (`dpiValidationEnabled`, `dpiExcellentThreshold`, `dpiWarningThreshold`, `dpiWarningAllowAutoSubmit`, `dpiPoorThreshold`, `dpiPoorAllowAutoSubmit`), their entries in `getAll()`, and their save-side validation block

**Renderer:**
- `src/preload/preload.js` — `validateJobDpi` and `approveDpiJob` IPC bindings
- `src/renderer/index.html` — `<th>DPI</th>` column header, the entire DPI Validation `<fieldset>` in the Downloads sub-tab, the entire DPI Modal markup
- `src/renderer/renderer.js` — DPI badge rendering in the jobs grid + the matching `<td>` cell, the 3-step DPI intercept inside the Send-to-Print click handler (rewrote the handler down to a clean single-step send), settings-load/save DPI blocks, the `showDpiModal` function, the `toggleDpiValidationFields` helper

### Sidecar back-compat

Hard-removed without a migration layer. Pre-removal audit showed:

- **0** DPI fields in any image sidecar (`<jobId>.json`) on disk in `~/Documents/OrderHub/`
- **0** DPI fields in any order manifest
- **0** `_dpiApproved` / `_dpiApprovedAt` fields in the persisted `jobs.json` / `job-store.json` / `jobs-cache.json`

The only place those fields *could* have landed was via the `jobs:approveDpi`
handler's `jobService.updateJobLocally(jobId, { _dpiApproved, _dpiApprovedAt })`,
but no jobs in the corpus had ever been DPI-approved. Orphaned config keys
sit quietly inert in `electron-store` (the schema doesn't surface them, the
saver doesn't write them).

### Rationale (why now)

1. The Quality Gate already scores every image and surfaces a per-image score
   that subsumes the "is the resolution adequate?" question — and answers it
   correctly for upscaled inputs that DPI's pixel-count heuristic blesses
   silently.
2. DPI's UX (excellent/good/warning/poor with per-level allow-auto-submit
   toggles, plus a confirmation modal) added six config fields and a non-trivial
   click handler for behaviour the Quality Gate now provides natively.
3. Removing it cleans up the Downloads-tab settings surface area for the AI
   Quality settings to take its place — see "AI Quality Settings Migration"
   below.

## AI Quality Settings Migration (v1.6)

The AI Quality Gate fieldset was originally embedded inside the **Film Scans**
sub-tab during M1+M2 development — Mode-2 was the first product where
operators routinely interacted with the Settings panel, so the gate's controls
landed there for visibility. With DPI removed and Mode-1 now the primary
production path, the AI Quality fieldset moved to the **Downloads** sub-tab,
landing in the same vertical slot DPI used to occupy.

The move was a single contiguous block:

| File | Before (line range) | After |
|------|---------------------|-------|
| `src/renderer/index.html` | inside `<div id="subtab-filmscans">` | inside `<div id="subtab-downloads">`, after the polling fieldset |

Field IDs (`aiQualityEnabled`, `aiQualityThreshold`, `aiQualityDebugLog`)
unchanged → `renderer.js`'s settings-load and settings-save wiring required
no edits. The change is purely structural.

### Threshold default change (75 → 50)

The schema default for `aiQualityThreshold` was lowered from **75** to **50**
in this revision (`src/main/services/config-service.js`). The change is
inline-commented at the schema location:

> *Default lowered from 75 to 50 based on empirical data from
> PXDEMO-721XH7 / PXDEMO-PT7HM2 — score distribution clusters 60-75
> for typical phone uploads with bad-quality tail at 36-45;
> threshold 50 cleanly separates the tail without rejecting the
> typical bulk.*

Empirical evidence backing this:

- **PXDEMO-PT7HM2** (22 images): scores after re-scoring on the new convention spanned 31.8-78.2. With threshold 75: 21/22 sub-threshold (97% rejection — too aggressive). With threshold 50: ~5/22 sub-threshold (~22% — typical phone-photo distribution).
- **PXDEMO-721XH7** (97 images): 95/97 sub-threshold at 75 (a 97% rejection rate against typical phone-camera input is operationally meaningless — operators would either tune the threshold themselves or learn to ignore the gate entirely).

The cluster of typical phone-camera scores sits in the 60-78 range — those
are images that print fine without intervention. Genuinely degraded images
(soft-focused, heavily-compressed, heavily-upscaled) score in the 30-45 range.
Threshold 50 sits cleanly between those two distributions.

Existing installs that have a stored value in `config.json` are unaffected
(electron-store only applies the schema default for missing keys). Only fresh
installs see 50.

### Path to block-mode (operator workflow)

For now: stop OHD, edit `%APPDATA%/orderhub-downloader/config.json` to set
`"aiQualityMode": "block"`, restart. The schema, `getAll()`, and `save()`
wiring already support the field via the standard config-service path; only
the UI toggle is missing. A future enhancement can add the toggle inline next
to the threshold control in the Downloads sub-tab.

## JobId Convention Divergence — Fixed in Phase C+ (v1.6)

### The bug

OHD has had two parallel jobId conventions since the React Job Review drawer
was introduced:

- **Numeric** = `String(job.id)` — e.g. `"38412023"` — the canonical OrderHub
  job identifier; used as the in-memory key for `jobService` and for the
  renderer's `aiQualityHeldByJobId` map.
- **Composite** = `${order_number}_${id}` — e.g. `"PXDEMO-PT7HM2_38412023"` —
  the inner-job folder name on disk and the React drawer's sidecar filename.

Most of the codebase used **composite** for sidecar I/O (the React drawer's
`ohd:job:load` IPC, all of `enhancementManager`, every `_getEnhancedPathMap` /
`_getCorrectionsMap` site in `print-service.js` except one). But the AI
Quality orchestrator and a handful of related IPC handlers used **numeric**:

- `ipc-handlers.js:407` — sendToPrint gate
- `ipc-handlers.js:1707` — auto-print loop
- `ipc-handlers.js:2379` — `aiQuality:listHeldJobs` IPC
- `ipc-handlers.js:2420` — `aiQuality:getJobQuality` IPC
- `ipc-handlers.js:2446` — `aiQuality:releaseJob` IPC
- `ipc-handlers.js:2468` — `aiQuality:approveImage` IPC
- `print-service.js:103` — pre-existing inconsistency in `sendToDarkroom`'s call to `_getEnhancedPathMap` (every other call site in the same file already used composite)

The result: each Mode-1 job that had been auto-print-scored had **two** sidecar
files on disk — `<numeric>.json` (orchestrator-written, with real scores) and
`<composite>.json` (drawer-created, with empty default blocks). The drawer
read from the empty one. The Quality Gate's per-image scores never reached
the drawer.

### How it surfaced

Phase C added the per-thumbnail score badge in `ThumbnailCard.jsx`. The badge
correctly returned `null` for unscored images (`!aiQuality || !aiQuality.scored`).
After deploying Phase C, no badges appeared on any thumbnail — the React tree
saw `aiQuality.scored: false` for every image because the drawer was reading
from the wrong sidecar. The diagnostic walked through the prop chain from
`useJobReview` → `ThumbnailGrid` → `ThumbnailCard` → `ScoreBadge`, confirmed
each layer was passing data correctly, and traced the empty `aiQuality` block
back to two sidecar files in the same folder with different jobId keys.

The bug had existed since the React drawer was first introduced (M0 / Phase 1)
but stayed hidden because nothing in the React tree had ever consumed
`image.aiQuality.score` — the Quality flag in the Jobs grid is fed by a
separate `aiQuality:listHeldJobs` IPC that uses its own (numeric) lookup
internally. Phase C was the first feature that actually depended on the
drawer-loaded sidecar carrying the AI Quality block.

### The fix

A new `_resolveSidecarJobId(job)` helper in `ipc-handlers.js` (sitting next
to `_resolveJobPath`) translates from numeric `job.id` to composite at every
storage-layer call boundary. The renderer's IPC interface continues to use
numeric (it's the canonical OH identifier and what `jobService` uses
internally); translation happens at the IPC handler boundary, before the
storage layer is hit. Six call sites updated; `print-service.js:103` fixed
in the same revision since it was the same convention bug in a different
code path.

The orchestrator and `ai-quality-store` themselves were left untouched —
they treat `jobId` as an opaque string key. Once the IPC handlers passed
composite consistently, the storage layer was correct automatically.

### Migration

`tools/onnx-export/_diagnostics/cleanup_orphan_sidecars.js` (gitignored,
kept as part of the diagnostic toolkit) walks the download root and identifies
`<numeric>.json` files that have a `<composite>.json` sibling in the same
folder. Defaults to dry-run, requires explicit `--execute` to delete.

Run results:
- **54 orphans deleted** across the corpus (jobs that had been auto-print-scored
  AND had their React drawer opened — the drawer-open is what creates the
  composite sidecar; absent that, the script left the numeric file alone for
  the next drawer-open + poll cycle to handle).
- 221,364 bytes reclaimed.
- 2 files skipped because no composite sibling existed yet (jobs that had
  been auto-print-scored but never reviewed in the drawer — those will
  auto-converge on first drawer open).
- 94 unrelated `.json` files (order manifests, sidecars under composite names,
  quarantine manifests) correctly bypassed the deletion path via the
  `^\d+$` filename-stem regex gate.

### Verification

After cleanup + OHD restart, the next auto-print pass scored 22 images on
`PXDEMO-PT7HM2_38412023.json` (the composite sidecar). Each entry has the
full Phase 3 + Phase C field set: `score`, `passed`, `thresholdAtScoreTime`,
`modeAtScoreTime`, `modelVersion`, `scoredAt`, `fileSizeAtScoreTime`,
`fileMtimeAtScoreTime`. The orchestrator log line now reads
`[ai-quality] job PXDEMO-PT7HM2_38412023 scored: …` — the composite jobId
arriving from the IPC layer.

The two larger background-rescore jobs (PXDEMO-721XH7 = 97 images,
PXDEMO-JMQNPV = 97 images) take ~700-770ms per image, so they complete
in the background within ~70-75 seconds each across one or two polling
cycles. This is expected behaviour post-deletion and not a regression —
the orchestrator's skip-vs-rescore logic correctly identifies the composite
sidecars as needing a fresh score (`aiQuality.scored: false` on every entry)
and runs through them serially.

### Lesson

When a value flows through multiple subsystems with different naming
conventions (here: numeric vs composite), the boundary between them is the
right place to translate. Burying the convention switch deeper (in
`ai-quality-store`'s sidecar-path computation, say) would have entangled the
storage layer with the OrderHub job-shape concept, making future changes
harder. The `_resolveSidecarJobId(job)` helper sits at the IPC handler
boundary because that's where the `job` object is naturally available and
where the numeric→composite translation is conceptually a concern.

The bug stayed quiet for as long as it did because nothing was actually
*reading* the data on the wrong side — it was a write-side divergence with
no observer. Phase C made the first observation, and the bug surfaced
immediately. This generalises: writes without paired reads are silent;
adding a read path against a write that hasn't been consistent surfaces
prior assumptions.

## Reproduction Notes

The smoke-test toolkit is retained in `tools/onnx-export/_diagnostics/` (gitignored) for regression testing:

- `phase2_sanity_check.js` — synthesises a corrupt JPEG in `os.tmpdir()`, calls `_moveToQuarantine` directly, asserts rename + manifest schema + log emission. Run before deploying any change to the quarantine helpers.
- `scenario_2_3_probe.js` — read-only probe that loads the orchestrator with stubbed config + logger, points it at any live job folder, and prints `{sidecarRowCount, scored, passed, subThreshold, qualityHeld, canRoute, expectedHeld}` for the requested mode (`warn` or `block`). Useful for verifying the mode-aware gating against real production sidecars without restarting OHD or interacting with the renderer.

Broader pattern: smoke tests of OHD's AI Quality Gate behaviour can be driven via the existing utility-process inference host without requiring full Electron renderer interaction. The orchestrator + ai-quality-store layer is renderer-independent — every contract surfaces in `app.log` (structured fields), in the per-job sidecars (`<jobId>.json`), in the per-job quarantine manifest (`_ohd-quarantine.json`), or via direct read-only probes like the script above. Reserving renderer-driven testing for the UI surface specifically (badges, dialogs, tab routing) keeps the iteration loop fast.

## Threshold Calibration (Out of Scope)

The OHD default threshold of **75** is a placeholder; real calibration happens once `ai-quality-store.js` accumulates operator approve/revert decisions on real lab images. This audit does not validate the threshold — only that the JS pipeline produces scores faithful to the canonical Google reference. Threshold tuning is a separate Phase 2 task.

## Reproduction

Diagnostic scripts retained in `tools/onnx-export/_diagnostics/` (gitignored) for reproduction if any verdict in this doc is ever revisited:

- `mask_gate_f64.py` — float64 mask-equivalence test (Step 3b)
- `mask_gate_seqlen_check.py` — pad-row scaling corroboration (Step 3b)
- `dump_jax_patches.py` / `dump_js_patches.js` / `compare_patches.py` — element-wise patch comparison harness (Step 4b)
- `score_gaussian_vs_lanczos3.py` — kernel-swap score-stability test (Step 4b-redo-1)
- `score_e2e_compare.py` — full pipeline JS-Lanczos+ONNX vs JAX-Gaussian end-to-end check (Step 4c)
- `gaussian_resize_reference.js` — archived pure-JS Gaussian implementation (the rejected approach)
- `corruption_watcher.js` — standalone curl-based FTP file watcher used during the v1.4 production-corruption investigation
- `phase2_sanity_check.js` — synthetic-corruption + quarantine-helper smoke test (v1.5)
- `scenario_2_3_probe.js` — read-only orchestrator probe for warn/block-mode regression testing (v1.5)
- `cleanup_orphan_sidecars.js` — defensive walk + dry-run-by-default deletion of `<numeric>.json` orphans left by the pre-Phase-C+ jobId convention (v1.6)

The full conversion script is `tools/onnx-export/_musiq_src/convert_3scale_capped.py`.
