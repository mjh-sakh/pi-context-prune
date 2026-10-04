---
name: 048-smart-upstream-rebase
description: Rebase fork features onto upstream 2.1.0 while preserving upstream defaults and accounting.
steps:
  - phase: integration
    steps:
      - "- [x] step 1: preserve local and remote tips and create integration branch"
      - "- [x] step 2: resolve two feature commits preserving upstream behavior"
  - phase: validation
    steps:
      - "- [x] step 1: add regression tests and run checks"
      - "- [x] step 2: review final diff and commit integration fixes"
---

# Smart upstream rebase

## Integration
- [x] step 1: preserve local and remote tips and create integration branch
- [x] step 2: resolve two feature commits preserving upstream behavior

## Validation
- [x] step 1: add regression tests and run checks
- [x] step 2: review final diff and commit integration fixes

## Result

Integration branch: `integrate/upstream-2.1-prune-features`, based on `source/main` at `7f27bee` (2.1.0).
Backups: `backup/local-prune-before-upstream-20260723` (`dec4d46`) and `backup/remote-prune-before-upstream-20260723`.
Original local feature branch and all remotes remain unchanged. No push performed.

Replayed two feature commits as `3bcd8f8` (threshold) and `e3ab994` (concurrency / working status).
Accepted upstream agentic-auto / agent-message defaults. Persisted explicit user settings remain intact.

Conflict resolutions retain upstream provider-owned streaming, auth forwarding, getAgentDir configuration path,
startup/skip notification controls, context hydration, internal summary wrapper, compiled packaging, and appendUsage accounting.
Bounded workers use allSettled before returning/rethrowing so cancelled calls finish billing before stats persistence.
No post-processing stats addition: onUsage is the single accounting path, including paid failures and discarded summaries.

Follow-up fixes cache final wrapped oversized-summary lengths for warnings (no repeated ref allocation),
and distinguish mixed tiny/oversized skip messages from exclusively tiny batches. README covers both fork settings.

## Verification

- `mise exec -- npm run check`: build, package-content check, and all 21 tests pass (no skipped tests).
- `git diff --check`: clean.
- Compiled `dist/index.js` import/factory smoke: both tools and `/pruner` register successfully.
- Reviewed upstream-relative diff and range-diff of original versus replayed feature commits.
- Tests exercise real capture/grouping, frontier, index, flush, provider callback contract, tool output,
  usage-report persistence, configuration migration, and real `/pruner now` command wiring.
- Covered threshold boundaries/disabled mode, skipped raw-result retention/retry avoidance,
  concurrency 1/4/7, stable order, completion hooks, pre-skips, abort drainage/no queued starts,
  usage once per paid call including later calls after an earlier failure, progress reset,
  sequential manual command, session delivery, notification controls, and mixed skip reasons.
- Test settings are confined to temporary directories under node_modules; user settings were not changed.

## Limitations

No live provider calls or visual interactive-TUI checks were performed. Widget/working progress callbacks
and command wiring were exercised in automated tests; visual checks remain a recommended pre-publication step.
Project dependencies were refreshed with `mise exec -- npm install --package-lock=false` (no manifest/lock change).
Install reported 5 dependency audit findings (1 low, 4 high). A follow-up audit requires a lockfile, which upstream
currently does not track; dependency remediation was not bundled into this rebase.
