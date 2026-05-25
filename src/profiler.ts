export interface ProfileEvent {
  elapsedMs: number;
  label: string;
  details?: string;
}

export interface PruneProfiler {
  mark(label: string, details?: string): void;
  scoped(label: string, details?: string): () => number;
  lines(limit?: number): string[];
  summary(limit?: number): string;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function createPruneProfiler(name = "context-prune"): PruneProfiler {
  const start = nowMs();
  const events: ProfileEvent[] = [];

  const mark = (label: string, details?: string) => {
    const elapsedMs = nowMs() - start;
    events.push({ elapsedMs, label, details });
    console.info(`[${name}] +${formatMs(elapsedMs)} ${label}${details ? ` — ${details}` : ""}`);
  };

  return {
    mark,
    scoped(label: string, details?: string) {
      const scopedStart = nowMs();
      mark(`${label}: start`, details);
      return (extra?: string) => {
        const durationMs = nowMs() - scopedStart;
        mark(`${label}: done`, `${formatMs(durationMs)}${extra ? ` · ${extra}` : ""}`);
        return durationMs;
      };
    },
    lines(limit = 30) {
      const tail = events.slice(-limit);
      return tail.map((event) =>
        `+${formatMs(event.elapsedMs)} ${event.label}${event.details ? ` — ${event.details}` : ""}`
      );
    },
    summary(limit = 30) {
      return this.lines(limit).join("\n");
    },
  };
}
