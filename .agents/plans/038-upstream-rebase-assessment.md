---
name: 038-upstream-rebase-assessment
description: Understand fork features and upstream changes, then recommend a rebase without changing history.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: fetch remotes and establish divergence"
      - "- [x] step 2: inspect fork features and upstream behavior changes"
  - phase: assessment
    steps:
      - "- [x] step 1: assess conflicts and feature interactions"
      - "- [x] step 2: document a proposed rebase and validation sequence"
---

# 038 — Upstream rebase assessment

## Discovery
- [x] step 1: fetch remotes and establish divergence
- [x] step 2: inspect fork features and upstream behavior changes

## Assessment
- [x] step 1: assess conflicts and feature interactions
- [x] step 2: document a proposed rebase and validation sequence

No branch history changes were made. Both remotes were fetched. No tests were run for this read-only code assessment.

## Git state

- Checked-out branch: `feat/prune-concurrency-working-status`, HEAD `dec4d46`.
- Upstream: `source/main`, HEAD `7f27bee` (release 2.1.0).
- Merge base: `e077162` (checkpoint tool rename, already upstream).
- Local-only commits: `37e13ff` minimum raw-size guard; `dec4d46` concurrency and working status.
- Upstream-only commits: 46, including release/doc/merge commits.
- `origin/main` is still at 1.2.0 (`1d8ef1c`).
- Remote feature branch is ahead of local in ancestry because it already contains the internal-summary wrapper changes. Its concurrency patch is equivalent; its threshold patch differs by wrapper integration. Do not merge/pull both copies or replay its upstream wrapper commits.
- Separate minimum-threshold and profiling/timeout branches exist. Timeout behavior is not present on current HEAD and is outside this two-feature rebase unless explicitly requested.

## Fork features

1. Minimum raw-size guard: presets 0/700/1000 chars, default 700, applied after final grouping. Undersized batches incur no LLM call, keep raw results, and advance the frontier so they are not repeatedly attempted. New skip outcome types and command/tool reporting.
2. Bounded summarizer concurrency: 1/4/7, default 4, ordered result array backed by a worker pool. Automatic paths use the configured limit; `/pruner now` remains sequential.
3. Working status: `Context prune: X/Y batches completed (batching label)`; counts pre-skips and completed calls and resets in finally. Bundled with concurrency commit.

Existing feature plans leave threshold tests and working-row manual checks incomplete.

## Upstream changes to retain

- Internal `<context-prune-summary>` wrapper and defensive unwrapping in displays.
- Provider-owned streaming via modelRegistry.getProvider(), normalizeContext(), auth baseUrl/env forwarding.
- Startup notice toggle and notifySkipped setting respected by automatic/manual oversized notifications.
- Configuration path based on getAgentDir() rather than hardcoded home directory.
- On-demand session hydration in context hook for extension initialization ordering.
- New defaults: agentic-auto trigger and agent-message batching; existing persisted explicit settings remain unchanged.
- Bundled dist/index.js packaging, build/package tests, Pi peer requirement >=0.86.0.
- Summarizer accounting through Pi appendUsage(); pi-stats consumes those entries. Final response usage counted even for failed/oversized/aborted results, independently of summary persistence.
- Parallel calls settle before final stats persistence.

## Conflict assessment

Non-checkout `git merge-tree --write-tree HEAD source/main` confirmed content conflicts in README.md, index.ts, src/commands.ts, src/config.ts, src/summarizer.ts, src/types.ts. Actual per-commit rebase conflicts may differ.

Most important semantic resolutions:

- Keep fork worker pool but use allSettled for workers and rethrow only after every active worker settles. Stop dequeuing on cancellation. Preserve upstream onUsage for single-batch and every worker call, plus fork onBatchComplete/text callbacks.
- Remove fork's post-processing statsAccum.add(result.usage): upstream onUsage already counts it. Otherwise successful calls are billed twice in local stats, while unpersisted later calls can be omitted.
- Preserve upstream capture of the original session manager and final stats persistence, together with working-message reset.
- Pass usage callbacks through the eligible-batch filtering path. Pre-skipped tiny batches must emit no usage.
- Compare final wrapped summary including refs against raw length, not an unwrapped estimate.
- Keep upstream notification controls while preserving quiet automatic too-small skips.
- Current generic `skipped` response inaccurately describes mixed too-small and oversized outcomes as all below threshold. Fix wording during integration and test mixed cases.
- Upstream agent-message batching makes batches larger, so fewer minimum-size skips and often fewer concurrent calls. Keep this default unless the user chooses a fork policy override.
- Upstream tests construct a partial config without summarizerConcurrency. Add concurrency to the fixture (or intentionally provide a runtime fallback); the current worker-count calculation would otherwise schedule zero workers.

## Proposed execution (requires approval)

1. Preserve current local and remote tips with explicit backup refs. Save/commit this assessment separately so it does not obstruct rebase or become an accidental feature commit.
2. Create a new integration branch from current HEAD; leave existing feature branch and remote untouched initially.
3. Rebase exactly the two local feature commits: `git rebase --onto source/main e077162 <integration-branch>`.
4. Resolve threshold commit against upstream flush/accounting/wrapper behavior, then resolve concurrency commit with the settlement guarantees above.
5. Add tests for threshold boundary/equality, disabled guard, no usage for tiny batches, frontier preservation, mixed skip reasons; concurrency 1/4/7, stable result order, usage once per paid call, cancellation drainage and no queued starts; working status cleanup on success/skip/failure/abort.
6. Run build/package/upstream usage tests with the project-local toolchain; manually check automatic progress and sequential `/pruner now`.
7. Review resulting diff against source/main. Publish a new branch first; only replace original feature branch with explicit approval and force-with-lease against its captured remote tip.

Decision to discuss: accept upstream agentic-auto / agent-message defaults (recommended), or deliberately retain agent-message / turn as a fork-specific override.
