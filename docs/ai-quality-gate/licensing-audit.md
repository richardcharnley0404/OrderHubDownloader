# MUSIQ-SPAQ Licensing Audit — AI Quality Gate

**Audit date:** 2026-04-27
**Auditor:** Claude Code (with Richard Charnley, Pixfizz Limited, as reviewer)
**Document version:** v1.5

## Code License

The MUSIQ source code under `google-research/google-research/musiq/` (including `multiscale_transformer.py`, `multiscale_transformer_utils.py`, `preprocessing.py`, `resnet.py`, and `run_predict_image.py`) is published under the Apache License 2.0, per the top-level `LICENSE` file at `https://github.com/google-research/google-research/blob/master/LICENSE` and the parent `README.md` declaration that "All source files in this repository are released under the Apache 2.0 license."

## Weights License

The trained SPAQ-variant weights are published as Apache 2.0 by Google in two channels: Kaggle's model registry exposes `licenseName: "Apache 2.0"` on the SPAQ instance (`https://www.kaggle.com/models/google/musiq/TensorFlow2/spaq`, instance ID 1119, version 1331), and the same weights are linked from the Apache-licensed `/musiq/README.md` for download from `gs://gresearch/musiq/spaq_ckpt.npz`.

## Distribution Channel Choice

Google's GCS distribution at `gs://gresearch/musiq/spaq_ckpt.npz` (the **3-scale** checkpoint, native + 224 + 384 resolution scales) is the chosen source for the bundled weights. The single-scale checkpoint at `gs://gresearch/musiq/full_size_single_scale/spaq_ckpt.npz` was investigated as a possible drop-in alternative but rejected after empirical testing (it diverged by ~19 MOS points from the 3-scale variant on synthetic-upscale inputs — exactly the failure mode the AI Quality Gate is designed to catch). Although Kaggle also hosts a TensorFlow SavedModel of the same training run that would be substantially less work to convert (single-stage `tf2onnx` against an already-TF graph), the Kaggle ToU review surfaced unresolved ambiguity about whether Kaggle's "personal, non-commercial use" language applies to third-party content distributed through the platform; the GCS bucket is not subject to any platform-level terms layered on top of the Apache 2.0 license. The engineering trade-off is material: the GCS file is a JAX/Flax `.npz` bound to the deprecated `flax.nn.Module` API (Flax 0.3.3, last released September 2021), so conversion requires running Google's reference inference code in an isolated Python 3.9 / Flax 0.3.3 sandbox and then bridging JAX → TensorFlow SavedModel via `jax.experimental.jax2tf` before reaching `tf2onnx`. Both the GCS `.npz` and the (now-rejected) Kaggle TF SavedModel are published by Google as Apache 2.0 outputs of the same MUSIQ-SPAQ training run. Exact byte-equivalence between the two distribution forms has not been independently verified for the purposes of this audit.

## Kaggle ToU Review

**Review date:** 2026-04-27 (Kaggle ToU Effective Date: June 22, 2025, the version current as of the review date)
**Verdict:** Ambiguous — Section 5 personal/non-commercial language could be read to override stated model licenses; cannot be resolved without legal counsel; conservative call is to avoid Kaggle for commercial use.

Section 5 of Kaggle's Terms of Use (`https://www.kaggle.com/terms`) restricts use of "the Services" to "personal, non-commercial" purposes. The relevant verbatim clause:

> "You will only use the Services for your own internal, personal, non-commercial use, and not on behalf of or for the benefit of any third party, and only in a manner that complies with all laws that apply to you."

This language is most likely intended to govern Kaggle's own platform features (notebooks, competitions, the web UI) rather than third-party content distributed through it, but it is loose enough that a careful reading admits the alternative interpretation that Kaggle's terms layer on top of any model license stated by the model's publisher. Without in-house legal counsel to interpret this in Pixfizz Limited's favor, the ambiguity is treated as a yellow flag and the Kaggle platform is avoided entirely for OHD's commercial release artifact. This verdict drove the pivot to the GCS distribution channel described above.

## Scope and Limitations

This audit covers the **3-scale SPAQ-trained variant of MUSIQ** only (`gs://gresearch/musiq/spaq_ckpt.npz`, the checkpoint at the bucket root rather than the `full_size_single_scale/` subdirectory). The single-scale SPAQ variant (`gs://gresearch/musiq/full_size_single_scale/spaq_ckpt.npz`) carries the same Apache 2.0 declaration but is not the artifact bundled in OHD. The AVA, KonIQ-10k, and PaQ-2-PiQ checkpoints, while published under the same Apache 2.0 declarations, are out of scope and would require separate verification before any future use.

## Cross-References

See `/THIRD_PARTY_LICENSES.md` (repository root) for the user-facing attribution text and verbatim Apache 2.0 license text shipped with the OHD installer for compliance with §4 of the upstream license, including the "Modifications by Pixfizz Limited" notice for the JAX-to-ONNX conversion. See `conversion-audit.md` (sibling file) for the engineering verdict on the JAX → TF → ONNX conversion pipeline, including numerical-equivalence findings, the SAME-padding bug discovery, and the production race-condition observation flagged for Phase-2. The reproducible conversion artefacts live under `tools/onnx-export/` (gitignored).
