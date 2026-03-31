## v1.0.8 - 2026-03-27

### Added
- "Check Order Status" boolean field on Order Controllers (Epson, Noritsu, DPOF,
  Darkroom Pro). When ticked (default), OHD monitors the hot folder for printer
  acceptance/rejection after dispatch as before. When unticked, the job is marked
  as Printed immediately after dispatch — useful for sites where network conditions
  prevent reliable status folder detection.

## v1.0.7 - 2026-03-27

### Fixed
- Jobs whose process type has no controller assigned in Routing are now automatically
  copied to the configured Default Folder (or Process Folder) during auto-print,
  and marked as completed — previously they were silently skipped

## v1.0.6 - 2026-03-25

### Fixed
- Auto-print concurrency guard: concurrent triggers (polling, config save, routing save)
  no longer cause duplicate dispatch attempts that result in "Job folder not found" errors
- Auto-print date range now reads from user config (jobDateRange) instead of being
  hardcoded to 30 days, matching the Jobs tab filter
