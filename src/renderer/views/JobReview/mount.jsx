/**
 * src/renderer/views/JobReview/mount.jsx
 *
 * React entry point for the Job Review Panel.
 *
 * Mounts a React root into <div id="job-review-root"> and listens for
 * custom events dispatched by the vanilla renderer.js to open/close the
 * drawer without needing to share any framework state.
 *
 * Protocol:
 *   Open:   window.dispatchEvent(new CustomEvent('ohd:open-job-review', {
 *             detail: { jobId: 'JOB-00452', jobPath: 'C:\\jobs\\JOB-00452' }
 *           }))
 *
 *   Close:  window.dispatchEvent(new CustomEvent('ohd:close-job-review'))
 *           (Also triggered internally by the drawer's own close button / Escape.)
 */

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JobReviewDrawer } from './index.jsx';

// ── App shell ─────────────────────────────────────────────────────────────────

function JobReviewApp() {
  const [open,     setOpen]     = useState(false);
  const [jobId,    setJobId]    = useState(null);
  const [jobPath,  setJobPath]  = useState(null);
  const [ohJobId,  setOhJobId]  = useState(null);

  // Listen for open events from vanilla renderer.js.
  React.useEffect(() => {
    function onOpen(e) {
      setJobId(e.detail.jobId);
      setJobPath(e.detail.jobPath);
      setOhJobId(e.detail.ohJobId || null);
      setOpen(true);
    }

    function onClose() {
      setOpen(false);
    }

    window.addEventListener('ohd:open-job-review',  onOpen);
    window.addEventListener('ohd:close-job-review', onClose);
    return () => {
      window.removeEventListener('ohd:open-job-review',  onOpen);
      window.removeEventListener('ohd:close-job-review', onClose);
    };
  }, []);

  if (!open || !jobId || !jobPath) return null;

  return (
    <JobReviewDrawer
      jobId={jobId}
      jobPath={jobPath}
      ohJobId={ohJobId}
      onClose={() => setOpen(false)}
    />
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const container = document.getElementById('job-review-root');
if (container) {
  createRoot(container).render(<JobReviewApp />);
} else {
  console.error('[OHD] Could not find #job-review-root — Job Review Panel will not mount.');
}
