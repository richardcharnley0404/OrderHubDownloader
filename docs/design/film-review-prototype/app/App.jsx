// Main App — wires together state, routing (tab / roll open / focused frame),
// tweaks, and the BriefPanel.

const { useState: useStateApp, useEffect: useEffectApp, useMemo: useMemoApp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "regular",
  "confidenceViz": "border",
  "theme": "light",
  "flagBadgeStyle": "ring",
  "showKbdHint": true
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [tab, setTab] = useStateApp("film");
  const [rolls, setRolls] = useStateApp(() => window.makeFilmData());
  const [openRollId, setOpenRollId] = useStateApp(null);
  const [focusedFrame, setFocusedFrame] = useStateApp(null);
  const [briefOpen, setBriefOpen] = useStateApp(false);

  const openRoll = rolls.find((r) => r.roll_id === openRollId);

  const flaggedTotal = useMemoApp(() =>
    rolls.reduce((acc, r) => acc + r.frames.filter((f) => f.operator_flags.length > 0).length, 0),
  [rolls]);

  const readyCount = rolls.filter((r) => r.status === "ready_for_review").length;

  function flagFrame(frameId, payload) {
    setRolls((rs) => rs.map((r) => {
      if (r.roll_id !== openRollId) return r;
      return {
        ...r,
        frames: r.frames.map((f) => {
          if (f.frame_id !== frameId) return f;
          return {
            ...f,
            operator_flags: [...f.operator_flags, {
              ...payload,
              flagged_at: new Date().toISOString(),
            }],
          };
        }),
      };
    }));
  }

  function unflagFrame(frameId, idx) {
    setRolls((rs) => rs.map((r) => {
      if (r.roll_id !== openRollId) return r;
      return {
        ...r,
        frames: r.frames.map((f) => {
          if (f.frame_id !== frameId) return f;
          const nf = [...f.operator_flags];
          nf.splice(idx, 1);
          return { ...f, operator_flags: nf };
        }),
      };
    }));
  }

  function markReviewed(rollId) {
    setRolls((rs) => rs.map((r) => r.roll_id === rollId ? { ...r, status: "reviewed" } : r));
    setOpenRollId(null);
  }

  function openFrame(frameId) {
    setFocusedFrame(frameId);
  }
  function closeFrame() {
    setFocusedFrame(null);
  }
  function navFrame(delta) {
    if (!openRoll) return;
    const idx = openRoll.frames.findIndex((f) => f.frame_id === focusedFrame);
    const next = Math.max(0, Math.min(openRoll.frames.length - 1, idx + delta));
    setFocusedFrame(openRoll.frames[next].frame_id);
  }

  // Theme + density class on the root
  useEffectApp(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    document.documentElement.setAttribute("data-density", tweaks.density);
    document.documentElement.setAttribute("data-confviz", tweaks.confidenceViz);
    document.documentElement.setAttribute("data-flagbadge", tweaks.flagBadgeStyle);
  }, [tweaks.theme, tweaks.density, tweaks.confidenceViz, tweaks.flagBadgeStyle]);

  return (
    <div className={"app " + (tweaks.theme === "dark" ? "app--dark" : "")}
         data-screen-label="OHD Film Review">
      <OHDChrome
        tab={tab}
        onSelectTab={(t) => { setTab(t); if (t === "film") { /* keep state */ } }}
        badges={{ film: readyCount > 0 ? readyCount : null }}
      >
        {tab === "jobs" && <JobsPlaceholder />}
        {tab === "settings" && <JobsPlaceholder />}
        {tab === "activity" && <JobsPlaceholder />}
        {tab === "film" && (
          openRoll ? (
            <RollReview
              roll={openRoll}
              tweaks={tweaks}
              onBack={() => setOpenRollId(null)}
              onOpenFrame={openFrame}
              onFlagFrame={flagFrame}
              onMarkReviewed={markReviewed}
            />
          ) : (
            <RollList
              rolls={rolls}
              onOpen={(id) => setOpenRollId(id)}
            />
          )
        )}
      </OHDChrome>

      {focusedFrame && openRoll && (
        <FocusedFrame
          roll={openRoll}
          frameId={focusedFrame}
          onClose={closeFrame}
          onNav={navFrame}
          onFlag={flagFrame}
          onUnflag={unflagFrame}
        />
      )}

      {/* Persistent floating button for the design brief */}
      <button className="brief-fab" onClick={() => setBriefOpen(true)}
              title="Read the design brief">
        <Icon d={icons.note} size={14} /> Design brief
      </button>

      <BriefPanel open={briefOpen} onClose={() => setBriefOpen(false)} />

      {/* Tweaks panel */}
      <TweaksPanel>
        <TweakSection label="Grid" />
        <TweakRadio label="Density" value={tweaks.density}
                    options={["tight", "regular", "comfy"]}
                    onChange={(v) => setTweak("density", v)} />

        <TweakSection label="Confidence visualisation" />
        <TweakRadio label="Style" value={tweaks.confidenceViz}
                    options={["border", "opacity", "corner", "numeric"]}
                    onChange={(v) => setTweak("confidenceViz", v)} />

        <TweakSection label="Flag badge" />
        <TweakRadio label="Style" value={tweaks.flagBadgeStyle}
                    options={["ring", "corner", "veil"]}
                    onChange={(v) => setTweak("flagBadgeStyle", v)} />

        <TweakSection label="Appearance" />
        <TweakRadio label="Theme" value={tweaks.theme}
                    options={["light", "dark"]}
                    onChange={(v) => setTweak("theme", v)} />
        <TweakToggle label="Keyboard hint" value={tweaks.showKbdHint}
                     onChange={(v) => setTweak("showKbdHint", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
