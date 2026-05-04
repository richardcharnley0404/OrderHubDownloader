/**
 * src/main/services/frame-metadata-store.js
 *
 * Persistent per-frame metadata for the Film Scan pipeline (PW-007 Phase 1).
 *
 * Holds one record per TIFF processed by Mode 2, keyed by a stable `frameId`
 * derived from `${rollFolderName}_${sortedTiffIndex}`. Records accumulate
 * over the life of the app: the pipeline writes rotation results here, the
 * Film Review panel reads them, and the operator appends flags / notes back.
 *
 * Design notes:
 *   - Backed by electron-store at `frame-metadata.json` in userData.
 *   - NO schema is enforced (mirrors the dpof-state store in ipc-handlers.js).
 *     Callers add new fields as the feature grows; we never reject writes.
 *   - A "roll" is the containing folder — the folderName IS the roll id.
 *     Listing is done client-side by scanning the frames dict; fine at Phase 1
 *     scales (≤ a few thousand frames per user), worth revisiting later.
 *   - The store is append/merge-oriented: update() patches, it never clobbers
 *     fields you didn't pass. record() is equivalent to "create or replace".
 *
 * Contract (kept loose by design):
 *   record(frameId, data)        → write/replace a frame's record
 *   update(frameId, patch)       → shallow-merge new fields into the record
 *   get(frameId)                 → full record or null
 *   listByRoll(rollId)           → array of records for one roll, frameIndex-sorted
 *   listRolls()                  → array of { rollId, count, firstSeenAt, lastSeenAt }
 *
 * Roll/flag helpers for the Film Review panel (Milestone 4):
 *   listRollsWithSummary()       → listRolls() plus per-roll counts + review status
 *   getRollWithFrames(rollId)    → one roll's summary plus its full frame array
 *   appendFlag(frameId, flag)    → add a typed operator flag (stamps flaggedAt)
 *   removeFlag(frameId, idx)     → remove an operator flag by array index
 *   markRollReviewed(rollId)     → set reviewStatus=reviewed on every frame in a roll
 *
 * Roll-level state for Manual Review mode (PW-007 M7):
 *   recordRoll(rollId, data)     → write/replace a roll's metadata record
 *   updateRoll(rollId, patch)    → shallow-merge a patch into the roll record
 *   getRoll(rollId)              → roll record (uploadStatus, paths, error) or null
 *
 * Roll record holds the deferred-upload context that's needed when the
 * operator presses "Approve & Upload" — storagePath, locationId, s3Prefix —
 * plus uploadStatus ('pending' | 'uploading' | 'uploaded' | 'failed'),
 * uploadError, uploadedAt. Stored separately from frames because it's
 * roll-scoped, not per-frame.
 *
 * Typical record shape (as written by folder-watch-service in Milestone 1):
 *   {
 *     frameId: "<rollId>_<index>",
 *     rollId:  "<folderName>",
 *     frameIndex: 0,
 *     originalPath: "...",
 *     outputs: { tiff: "...", jpg: "..." },
 *     rotation: { applied: false, predictedClass: 0, predictedAngle: 0,
 *                 confidence: 1.0, modelVersion: "...", error: null,
 *                 inferenceMs: 12 },
 *     flags: {},               // operator-set flags — added in later milestones
 *     createdAt: "2026-04-24T...",
 *     updatedAt: "2026-04-24T..."
 *   }
 */

'use strict';

const Store = require('electron-store');

class FrameMetadataStore {
  constructor() {
    // Separate store file — keeps this data out of config.json and avoids
    // any risk of schema validation kicking in as the record shape evolves.
    this.store = new Store({
      name: 'frame-metadata',
      defaults: { frames: {}, rolls: {} },
    });
  }

  /**
   * Write (or replace) the roll-level metadata record. Roll records hold
   * upload state and the paths needed to perform a deferred S3 upload.
   *
   * Sets `createdAt` on first write, always refreshes `updatedAt`.
   */
  recordRoll(rollId, data = {}) {
    if (!rollId) throw new Error('frame-metadata-store.recordRoll: rollId is required');

    const rolls = this.store.get('rolls', {});
    const existing = rolls[rollId] || null;
    const now = new Date().toISOString();

    rolls[rollId] = {
      ...data,
      rollId,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.store.set('rolls', rolls);
    return rolls[rollId];
  }

  /**
   * Shallow-merge a patch into an existing roll record. Creates the record
   * if it doesn't exist yet. Top-level only — no nested merge here, since
   * the upload-state fields are flat.
   */
  updateRoll(rollId, patch = {}) {
    if (!rollId) throw new Error('frame-metadata-store.updateRoll: rollId is required');

    const rolls = this.store.get('rolls', {});
    const existing = rolls[rollId] || null;
    const now = new Date().toISOString();

    if (!existing) {
      this.store.set('rolls', rolls);
      return this.recordRoll(rollId, patch);
    }

    const merged = { ...existing, ...patch, rollId, updatedAt: now };
    rolls[rollId] = merged;
    this.store.set('rolls', rolls);
    return merged;
  }

  /**
   * Fetch the roll-level record. Returns null if no roll record exists —
   * this is the case for legacy rolls that pre-date M7, OR for rolls
   * processed in Off/Auto modes where no roll record was written.
   */
  getRoll(rollId) {
    if (!rollId) return null;
    const rolls = this.store.get('rolls', {});
    return rolls[rollId] || null;
  }

  /**
   * Remove a roll-level record. Used in M8-3 to clean up provisional
   * "detected/processing" records once the real roll record is written
   * under a different rollId (e.g. when _resolveStoragePath disambiguates
   * with a `_1` suffix). No-op if the rollId is unknown.
   */
  deleteRoll(rollId) {
    if (!rollId) return false;
    const rolls = this.store.get('rolls', {});
    if (!rolls[rollId]) return false;
    delete rolls[rollId];
    this.store.set('rolls', rolls);
    return true;
  }

  /**
   * Write (or replace) the full record for one frame.
   *
   * Sets `createdAt` on first write, always refreshes `updatedAt`.
   * `frameId` and `rollId` are always persisted, even if the caller's `data`
   * is missing them — this keeps the record self-describing for listByRoll.
   */
  record(frameId, data = {}) {
    if (!frameId) throw new Error('frame-metadata-store.record: frameId is required');

    const frames = this.store.get('frames', {});
    const existing = frames[frameId] || null;
    const now = new Date().toISOString();

    frames[frameId] = {
      ...data,
      frameId,
      rollId: data.rollId || (existing && existing.rollId) || null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.store.set('frames', frames);
    return frames[frameId];
  }

  /**
   * Shallow-merge a patch into an existing record. Creates the record if it
   * doesn't exist yet (so callers don't have to know whether record() was
   * called first).
   *
   * Nested objects (rotation, outputs, flags) are MERGED one level deep, so
   * `update(id, { rotation: { applied: true } })` preserves the other rotation
   * fields instead of replacing the whole sub-object.
   */
  update(frameId, patch = {}) {
    if (!frameId) throw new Error('frame-metadata-store.update: frameId is required');

    const frames = this.store.get('frames', {});
    const existing = frames[frameId] || null;
    const now = new Date().toISOString();

    if (!existing) {
      // First touch — just delegate to record() so createdAt is set correctly.
      this.store.set('frames', frames);
      return this.record(frameId, patch);
    }

    const merged = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])
      ) {
        merged[key] = { ...existing[key], ...value };
      } else {
        merged[key] = value;
      }
    }
    merged.frameId = frameId;
    merged.updatedAt = now;

    frames[frameId] = merged;
    this.store.set('frames', frames);
    return merged;
  }

  /**
   * Fetch a single frame record. Returns null if unknown.
   */
  get(frameId) {
    if (!frameId) return null;
    const frames = this.store.get('frames', {});
    return frames[frameId] || null;
  }

  /**
   * All records for one roll, sorted by frameIndex ascending.
   * Records with a missing/NaN frameIndex sort last but are still returned.
   */
  listByRoll(rollId) {
    if (!rollId) return [];
    const frames = this.store.get('frames', {});
    const out = [];
    for (const rec of Object.values(frames)) {
      if (rec && rec.rollId === rollId) out.push(rec);
    }
    out.sort((a, b) => {
      const ai = Number.isFinite(a.frameIndex) ? a.frameIndex : Number.POSITIVE_INFINITY;
      const bi = Number.isFinite(b.frameIndex) ? b.frameIndex : Number.POSITIVE_INFINITY;
      return ai - bi;
    });
    return out;
  }

  /**
   * Summarise every roll seen so far. One entry per distinct rollId.
   * Sorted by lastSeenAt descending so the most recently touched roll is first —
   * suits the Film Review panel's default "latest on top" ordering.
   */
  listRolls() {
    const frames = this.store.get('frames', {});
    const byRoll = new Map();

    for (const rec of Object.values(frames)) {
      if (!rec || !rec.rollId) continue;
      const entry = byRoll.get(rec.rollId) || {
        rollId: rec.rollId,
        count: 0,
        firstSeenAt: rec.createdAt || null,
        lastSeenAt: rec.updatedAt || rec.createdAt || null,
      };
      entry.count += 1;
      if (rec.createdAt && (!entry.firstSeenAt || rec.createdAt < entry.firstSeenAt)) {
        entry.firstSeenAt = rec.createdAt;
      }
      const touched = rec.updatedAt || rec.createdAt;
      if (touched && (!entry.lastSeenAt || touched > entry.lastSeenAt)) {
        entry.lastSeenAt = touched;
      }
      byRoll.set(rec.rollId, entry);
    }

    const rolls = [...byRoll.values()];
    rolls.sort((a, b) => {
      const at = a.lastSeenAt || '';
      const bt = b.lastSeenAt || '';
      if (at === bt) return 0;
      return at < bt ? 1 : -1;
    });
    return rolls;
  }

  /**
   * Roll summaries with the full set of counts the Film Review panel needs.
   * Status derivation is deliberately simple at Phase 1:
   *   - reviewed          → every frame in the roll has reviewStatus 'reviewed'
   *   - ready_for_review  → otherwise (any roll with records is post-ingest)
   * A 'processing' status would require live coordination with the pipeline
   * and is deferred to a later milestone.
   *
   * Low-confidence threshold (0.75) matches the design brief's visual
   * treatment — the UI paints these amber. Keep the threshold here in sync
   * with the renderer's ConfidenceDot bucketing.
   */
  listRollsWithSummary() {
    const frames = this.store.get('frames', {});
    const byRoll = new Map();

    for (const rec of Object.values(frames)) {
      if (!rec || !rec.rollId) continue;
      let entry = byRoll.get(rec.rollId);
      if (!entry) {
        entry = {
          rollId: rec.rollId,
          frameCount: 0,
          autoRotatedCount: 0,
          lowConfidenceCount: 0,
          rotationErrorCount: 0,
          flaggedCount: 0,
          reviewedCount: 0,
          firstSeenAt: rec.createdAt || null,
          lastSeenAt: rec.updatedAt || rec.createdAt || null,
          status: 'ready_for_review',
        };
        byRoll.set(rec.rollId, entry);
      }

      entry.frameCount += 1;

      const rot = rec.rotation || {};
      if (rot.applied === true) entry.autoRotatedCount += 1;
      if (rot.error) entry.rotationErrorCount += 1;
      if (typeof rot.confidence === 'number' && rot.confidence < 0.75) {
        entry.lowConfidenceCount += 1;
      }

      const flags = Array.isArray(rec.operatorFlags) ? rec.operatorFlags : [];
      if (flags.length > 0) entry.flaggedCount += 1;

      if (rec.reviewStatus === 'reviewed') entry.reviewedCount += 1;

      if (rec.createdAt && (!entry.firstSeenAt || rec.createdAt < entry.firstSeenAt)) {
        entry.firstSeenAt = rec.createdAt;
      }
      const touched = rec.updatedAt || rec.createdAt;
      if (touched && (!entry.lastSeenAt || touched > entry.lastSeenAt)) {
        entry.lastSeenAt = touched;
      }
    }

    // Merge in roll-level state (upload fields) for any roll that has a
    // record. Legacy rolls (pre-M7) won't have one — they get undefined
    // upload fields and the renderer treats that as "no upload tracking",
    // i.e. behaves the same as before.
    const rollRecords = this.store.get('rolls', {});

    const rolls = [...byRoll.values()].map((r) => {
      const rollRec = rollRecords[r.rollId] || null;
      return {
        ...r,
        status: r.frameCount > 0 && r.reviewedCount === r.frameCount
          ? 'reviewed'
          : 'ready_for_review',
        uploadStatus:    rollRec ? rollRec.uploadStatus    : undefined,
        uploadError:     rollRec ? rollRec.uploadError     : undefined,
        uploadedAt:      rollRec ? rollRec.uploadedAt      : undefined,
        storagePath:     rollRec ? rollRec.storagePath     : undefined,
        processingStatus: rollRec ? rollRec.processingStatus || null : null,
        detectedAt:      rollRec ? rollRec.detectedAt      : undefined,
      };
    });

    // M8-3: surface provisional roll records (detected / processing) that
    // exist in the rolls map but have zero frames yet. These render as
    // non-clickable placeholders in the panel so the operator can see that
    // their scan is queued — "watching" while the watchguard timer ticks
    // down, "processing" while the AI rotation pass + thumbnails run.
    const seenRollIds = new Set(rolls.map((r) => r.rollId));
    for (const rollRec of Object.values(rollRecords)) {
      if (!rollRec || !rollRec.rollId) continue;
      if (seenRollIds.has(rollRec.rollId)) continue;
      if (!rollRec.processingStatus) continue;  // only surface in-flight rolls
      rolls.push({
        rollId: rollRec.rollId,
        frameCount: 0,
        autoRotatedCount: 0,
        lowConfidenceCount: 0,
        rotationErrorCount: 0,
        flaggedCount: 0,
        reviewedCount: 0,
        firstSeenAt: rollRec.detectedAt || rollRec.createdAt || null,
        lastSeenAt:  rollRec.updatedAt || rollRec.detectedAt || rollRec.createdAt || null,
        status: 'ready_for_review',
        uploadStatus:    rollRec.uploadStatus,
        uploadError:     rollRec.uploadError,
        uploadedAt:      rollRec.uploadedAt,
        storagePath:     rollRec.storagePath,
        processingStatus: rollRec.processingStatus,
        detectedAt:      rollRec.detectedAt,
      });
    }

    rolls.sort((a, b) => {
      const at = a.lastSeenAt || '';
      const bt = b.lastSeenAt || '';
      if (at === bt) return 0;
      return at < bt ? 1 : -1;
    });
    return rolls;
  }

  /**
   * Full roll detail — the summary entry plus the complete array of frame
   * records sorted by frameIndex. Returns null if the roll is unknown.
   */
  getRollWithFrames(rollId) {
    if (!rollId) return null;
    const rollFrames = this.listByRoll(rollId);
    if (rollFrames.length === 0) return null;

    const summary = this.listRollsWithSummary().find((r) => r.rollId === rollId);
    if (!summary) return null;

    // Roll record is already merged into summary by listRollsWithSummary, so
    // uploadStatus/uploadError/uploadedAt/storagePath are present here too.
    return { ...summary, frames: rollFrames };
  }

  /**
   * Append an operator flag to a frame's operatorFlags array. Stamps
   * flaggedAt automatically so the renderer doesn't have to.
   *
   * `flag` shape:
   *   {
   *     type: 'rotation'|'scan_quality'|'exposure'|'other',
   *     note?: string,
   *     correctRotation?: 0 | 90 | 180 | 270  // only meaningful when type==='rotation'
   *   }
   *
   * `correctRotation` is the training-signal field: it's the rotation (in degrees,
   * relative to what the operator currently sees on screen) that would make the
   * frame appear upright. Null means "operator flagged but didn't label" — useful
   * as negative signal (model got it wrong) but not as positive training data.
   * When present, a flag is a fully-labelled training example.
   *
   * Returns the updated record, or null if the frame is unknown or the flag
   * is missing a required field.
   */
  appendFlag(frameId, flag) {
    if (!frameId || !flag || !flag.type) return null;
    const existing = this.get(frameId);
    if (!existing) return null;

    // Only accept correctRotation on rotation-type flags, and only if it's a
    // known canonical value. Anything else → null (unlabelled).
    const VALID_ROTATIONS = [0, 90, 180, 270];
    const correctRotation =
      flag.type === 'rotation' && VALID_ROTATIONS.includes(flag.correctRotation)
        ? flag.correctRotation
        : null;

    const operatorFlags = Array.isArray(existing.operatorFlags)
      ? [...existing.operatorFlags]
      : [];
    operatorFlags.push({
      type: flag.type,
      note: flag.note || null,
      correctRotation,
      flaggedAt: new Date().toISOString(),
    });

    return this.update(frameId, { operatorFlags });
  }

  /**
   * Remove an operator flag by array index (the flag-menu's "undo" path).
   * Returns the updated record, or null if frame/index is invalid.
   */
  removeFlag(frameId, flagIndex) {
    if (!frameId || typeof flagIndex !== 'number') return null;
    const existing = this.get(frameId);
    if (!existing) return null;
    if (!Array.isArray(existing.operatorFlags)) return null;
    if (flagIndex < 0 || flagIndex >= existing.operatorFlags.length) return null;

    const operatorFlags = [...existing.operatorFlags];
    operatorFlags.splice(flagIndex, 1);
    return this.update(frameId, { operatorFlags });
  }

  /**
   * Mark every frame in a roll as reviewed. Stamps reviewedAt on each.
   * Returns the number of frames touched; 0 if the roll has no records.
   */
  markRollReviewed(rollId) {
    if (!rollId) return 0;
    const rollFrames = this.listByRoll(rollId);
    const now = new Date().toISOString();
    let count = 0;
    for (const rec of rollFrames) {
      this.update(rec.frameId, { reviewStatus: 'reviewed', reviewedAt: now });
      count += 1;
    }
    return count;
  }

  /**
   * Remove every frame record belonging to a given roll. Used by the Film
   * Review delete-roll flow alongside `deleteRoll(rollId)` — together they
   * scrub all on-disk metadata for the roll so the panel forgets about it
   * and the upload path can't see it.
   *
   * Returns the number of frame records removed (0 if the roll was unknown
   * or already had no frames).
   */
  deleteFramesByRoll(rollId) {
    if (!rollId) return 0;
    const frames = this.store.get('frames', {});
    let removed = 0;
    for (const [frameId, rec] of Object.entries(frames)) {
      if (rec && rec.rollId === rollId) {
        delete frames[frameId];
        removed += 1;
      }
    }
    if (removed > 0) {
      this.store.set('frames', frames);
    }
    return removed;
  }

  /**
   * Test / devtools helper — wipes every frame record. NOT exposed over IPC.
   * Kept private-by-convention (leading underscore).
   */
  _clearAll() {
    this.store.set('frames', {});
  }
}

const frameMetadataStore = new FrameMetadataStore();
module.exports = frameMetadataStore;
module.exports.FrameMetadataStore = FrameMetadataStore;
