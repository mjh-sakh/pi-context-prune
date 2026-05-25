---
name: 033-prune-concurrency-and-working-status
description: Add a summarizer concurrency limit and replace Pi's default Working message during context pruning with batch completion progress.
steps:
  - phase: design
    steps:
      - "- [x] step 1: confirm the config shape and default concurrency value"
      - "- [x] step 2: define the exact working-status text and reset behavior"
  - phase: implementation
    steps:
      - "- [x] step 1: add a summarizer concurrency setting to shared types and config defaults"
      - "- [x] step 2: add a concurrency-limited batch summarization runner"
      - "- [x] step 3: report per-batch completion from summarization to flushPending"
      - "- [x] step 4: update ctx.ui.setWorkingMessage during pruning and restore it in finally"
      - "- [x] step 5: expose the concurrency setting in /pruner status, help, and settings/command UI if appropriate"
  - phase: validation
    steps:
      - "- [x] step 1: run typecheck/build"
      - "- [ ] step 2: manually verify a multi-batch prune shows Context prune: X/Y batches completed (Per turn)"
      - "- [ ] step 3: manually verify the Working message is restored after success, skip, or failure"
---

# 033-prune-concurrency-and-working-status

## Outcome
Add a configurable summarizer concurrency limit and replace Pi's generic `Working...` loader during pruning with:

```txt
Context prune: 15/25 batches completed (Per turn)
```

## Phase 1 — Design
- [x] step 1: confirm the config shape and default concurrency value
- [x] step 2: define the exact working-status text and reset behavior

## Phase 2 — Implementation
- [x] step 1: add a summarizer concurrency setting to shared types and config defaults
- [x] step 2: add a concurrency-limited batch summarization runner
- [x] step 3: report per-batch completion from summarization to flushPending
- [x] step 4: update ctx.ui.setWorkingMessage during pruning and restore it in finally
- [x] step 5: expose the concurrency setting in /pruner status, help, and settings/command UI if appropriate

## Phase 3 — Validation
- [x] step 1: run typecheck/build
- [ ] step 2: manually verify a multi-batch prune shows `Context prune: X/Y batches completed (Per turn)`
- [ ] step 3: manually verify the Working message is restored after success, skip, or failure

## Design notes

### Config
Add:

```ts
summarizerConcurrency: 1 | 4 | 7
```

Default: `4`.

Only expose these three choices in UI/commands/settings:

- `1` — safest/sequential
- `4` — default/balanced
- `7` — faster, higher provider pressure

When reading config, normalize any invalid or legacy value to the nearest allowed option, or fall back to `4`.

### Status text
Use the existing batching labels:

```txt
Context prune: {completed}/{total} batches completed ({batchingModeLabel})
```

Examples:

```txt
Context prune: 0/25 batches completed (Per turn)
Context prune: 15/25 batches completed (Per turn)
Context prune: 3/5 batches completed (Per agent message)
```

No streaming-char denominator should be shown in the global Working row.

### Scope
The concurrency limit should apply to automatic pruning paths that currently use parallel summarization. The existing `/pruner now` path already uses sequential processing when `onProgress` is supplied, so treat that as concurrency `1` for UI simplicity regardless of the saved setting.

### Reset behavior
Always restore the default Working message in `finally`:

```ts
ctx.ui.setWorkingMessage();
```

Do this even if summarization fails, skips all batches, or throws.
