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
      defaults: { frames: {} },
    });
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
