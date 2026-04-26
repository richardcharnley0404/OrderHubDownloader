// Mock roll + frame data for the Film Review Panel prototype.
// Deterministic (seeded) so the mock is stable across refreshes.

(function () {
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function buildFrames(rollSeed, count, thumbs) {
    const r = rng(rollSeed);
    const frames = [];
    for (let i = 0; i < count; i++) {
      // Most frames: high confidence, applied correctly.
      // A minority: low confidence. A rare few: rotation errors.
      const roll = r();
      let confidence, predicted, rotation_applied, rotation_error, misrotated;
      if (roll < 0.05) {
        // rotation error — pipeline fell through
        confidence = 0.4 + r() * 0.4;
        predicted = [0, 90, 180, 270][Math.floor(r() * 4)];
        rotation_applied = false;
        rotation_error = "sharp: input file is missing EXIF orientation tag";
        misrotated = true;
      } else if (roll < 0.22) {
        // low-confidence — might be wrong
        confidence = 0.45 + r() * 0.25;
        predicted = [0, 90, 180, 270][Math.floor(r() * 4)];
        rotation_applied = true;
        rotation_error = null;
        misrotated = r() < 0.4; // ~40% of low-conf are actually wrong
      } else {
        // confident & correct
        confidence = 0.9 + r() * 0.09;
        predicted = 0;
        rotation_applied = true;
        rotation_error = null;
        misrotated = r() < 0.02;
      }
      const thumb = thumbs[(i * 7 + rollSeed) % thumbs.length];
      // If "misrotated", we display it rotated to simulate the error.
      const display_rotation = misrotated ? [90, 180, 270][Math.floor(r() * 3)] : 0;
      frames.push({
        frame_id: `f_${rollSeed}_${i + 1}`,
        thumbnail_url: thumb.src,
        portrait: thumb.portrait,
        ai_predicted_angle: predicted,
        ai_confidence: confidence,
        rotation_applied,
        rotation_error,
        display_rotation, // only used by mock to visually fake a misrotation
        operator_flags: [],
        scan_order_in_roll: i + 1,
      });
    }
    return frames;
  }

  const ROLLS = [
    {
      roll_id: "00001247",
      scanned_at: "2026-04-24T08:02:00Z",
      processed_at: "2026-04-24T08:13:00Z",
      frame_count: 36,
      status: "ready_for_review",
      seed: 7,
    },
    {
      roll_id: "00001246",
      scanned_at: "2026-04-23T14:30:00Z",
      processed_at: "2026-04-23T14:41:00Z",
      frame_count: 36,
      status: "ready_for_review",
      seed: 12,
    },
    {
      roll_id: "00001245",
      scanned_at: "2026-04-23T09:15:00Z",
      processed_at: "2026-04-23T09:26:00Z",
      frame_count: 36,
      status: "ready_for_review",
      seed: 23,
    },
    {
      roll_id: "00001244",
      scanned_at: "2026-04-23T09:40:00Z",
      processed_at: "2026-04-23T09:52:00Z",
      frame_count: 24,
      status: "ready_for_review",
      seed: 31,
    },
    {
      roll_id: "00001243",
      scanned_at: "2026-04-24T10:20:00Z",
      processed_at: null,
      frame_count: 36,
      status: "processing",
      seed: 44,
    },
    {
      roll_id: "00001242",
      scanned_at: "2026-04-21T11:00:00Z",
      processed_at: "2026-04-21T11:10:00Z",
      frame_count: 36,
      status: "reviewed",
      seed: 55,
    },
  ];

  window.makeFilmData = function () {
    const thumbs = window.FILM_THUMBS;
    return ROLLS.map((rl) => {
      const frames = buildFrames(rl.seed, rl.frame_count, thumbs);
      const auto_rotated_count = frames.filter((f) => f.rotation_applied && f.ai_predicted_angle !== 0).length;
      const low_confidence_count = frames.filter((f) => f.ai_confidence < 0.75).length;
      const rotation_error_count = frames.filter((f) => !f.rotation_applied).length;
      return {
        ...rl,
        frames,
        auto_rotated_count,
        low_confidence_count,
        rotation_error_count,
        flagged_count: 0,
      };
    });
  };
})();
