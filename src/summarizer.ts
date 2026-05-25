import { stream } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  try {
    const batchLabel = `batch turn ${batch.turnIndex}`;
    const startedAt = nowMs();
    options.onProfile?.(`${batchLabel}: summarize start`, `${batch.toolCalls.length} tool calls`);

    const resolveStartedAt = nowMs();
    const model = resolveModel(config, ctx);
    options.onProfile?.(`${batchLabel}: resolve model`, formatMs(nowMs() - resolveStartedAt));

    const authStartedAt = nowMs();
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    options.onProfile?.(`${batchLabel}: auth`, formatMs(nowMs() - authStartedAt));
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const serializeStartedAt = nowMs();
    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
    options.onProfile?.(`${batchLabel}: serialize`, `${formatMs(nowMs() - serializeStartedAt)} · ${serialized.length} chars`);

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const streamCreateStartedAt = nowMs();
    const responseStream = stream(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) }
    );
    options.onProfile?.(`${batchLabel}: stream created`, formatMs(nowMs() - streamCreateStartedAt));

    let lastReportedChars = -1;
    let sawFirstText = false;
    const streamStartedAt = nowMs();
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        if (!sawFirstText) {
          sawFirstText = true;
          options.onProfile?.(`${batchLabel}: first text event`, formatMs(nowMs() - streamStartedAt));
        }
        reportTextProgress(event.partial);
      }
    }
    options.onProfile?.(`${batchLabel}: stream iteration`, `${formatMs(nowMs() - streamStartedAt)} · first text ${sawFirstText ? "yes" : "no"}`);

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");

    const resultStartedAt = nowMs();
    const response = await responseStream.result();
    options.onProfile?.(`${batchLabel}: stream result`, formatMs(nowMs() - resultStartedAt));
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    options.onProfile?.(`${batchLabel}: summarize done`, `${formatMs(nowMs() - startedAt)} · ${llmText.length} summary chars`);
    return {
      summaryText: llmText,
      usage: response.usage,
    };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  options.onProfile?.("summarizeBatches start", `${batches.length} batches · concurrency ${config.summarizerConcurrency}`);
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    const result = await summarizeBatch(batches[0], config, ctx, {
      signal: options.signal,
      onProfile: (label, details) => options.onProfile?.(`batch 1/1: ${label}`, details),
      onTextProgress: (receivedChars) => {
        options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
      },
    });
    options.onBatchComplete?.(0, 1, batches[0], result);
    return [result];
  }

  // Multiple batches — run with the configured concurrency limit; each produces
  // its own SummarizeResult while preserving input order in the returned array.
  const results: Array<SummarizeResult | null> = new Array(batches.length).fill(null);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < batches.length) {
      if (options.signal?.aborted) throw new Error("summarizeBatches: aborted before next batch");
      const index = nextIndex++;
      const batch = batches[index];
      options.onProfile?.(`worker batch ${index + 1}/${batches.length}: start`, `${batch.toolCalls.length} tool calls`);
      const result = await summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onProfile: (label, details) => options.onProfile?.(`batch ${index + 1}/${batches.length}: ${label}`, details),
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      });
      results[index] = result;
      options.onProfile?.(`worker batch ${index + 1}/${batches.length}: complete`, result ? "ok" : "null result");
      options.onBatchComplete?.(index, batches.length, batch, result);
    }
  };

  const workerCount = Math.min(config.summarizerConcurrency, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  options.onProfile?.("summarizeBatches done", `${batches.length} batches`);
  return results;
}
