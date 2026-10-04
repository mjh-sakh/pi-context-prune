// Regression coverage for fork features interacting with upstream 2.1 accounting.
// Stub only configuration and command UI wiring; execute the real flush engine,
// summarizer, capture, frontier, index, and model-facing prune tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = mkdtempSync(join(process.cwd(), 'node_modules', '.pruner-rebase-'));
const aiShim = join(temp, 'ai.mjs');
writeFileSync(aiShim, 'export const normalizeContext = value => value;\n');
await build({
  entryPoints: ['index.ts', 'src/types.ts', 'src/summarizer.ts'], outdir: temp,
  outbase: '.', bundle: true, platform: 'node', format: 'esm',
  alias: { '@earendil-works/pi-ai': aiShim },
  external: ['@earendil-works/pi-coding-agent'],
  outExtension: { '.js': '.mjs' },
  plugins: [{ name: 'test-wiring', setup(build) {
    build.onLoad({ filter: /src\/config\.ts$/ }, () => ({ contents:
      'export async function loadConfig() { return globalThis.__pruneConfig; }', loader: 'ts' }));
    build.onLoad({ filter: /src\/commands\.ts$/ }, () => ({ contents: `
      export function setPruneStatusWidget() {}
      export function registerCommands(pi, config, flush, capture) { pi.testFlush = flush; pi.testCapture = capture; }
    `, loader: 'ts' }));
  } }],
});
const { default: extension } = await import(pathToFileURL(join(temp, 'index.mjs')));
const { DEFAULT_CONFIG, CUSTOM_TYPE_FRONTIER, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_STATS, CUSTOM_TYPE_SUMMARY } =
  await import(pathToFileURL(join(temp, 'src/types.mjs')));
const { summarizeBatches } = await import(pathToFileURL(join(temp, 'src/summarizer.mjs')));
// Test real persistence in an isolated agent directory, never the user's settings.
const agentShim = join(temp, 'agent.mjs');
writeFileSync(agentShim, `export const getAgentDir = () => ${JSON.stringify(join(temp, 'agent'))};\n`);
await build({ entryPoints: ['src/config.ts'], outfile: join(temp, 'config.mjs'), bundle: true,
  platform: 'node', format: 'esm', alias: { '@earendil-works/pi-coding-agent': agentShim } });
const persistedConfig = await import(pathToFileURL(join(temp, 'config.mjs')));
await build({ entryPoints: ['src/commands.ts'], outfile: join(temp, 'commands.mjs'), bundle: true,
  platform: 'node', format: 'esm', external: ['@earendil-works/pi-coding-agent'],
  plugins: [{ name: 'no-user-settings', setup(build) {
    build.onLoad({ filter: /src\/config\.ts$/ }, () => ({ contents: 'export async function saveConfig() {}', loader: 'ts' }));
  } }],
});
const { registerCommands } = await import(pathToFileURL(join(temp, 'commands.mjs')));
const usage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16,
  cost: { input: .1, output: .2, cacheRead: 0, cacheWrite: 0, total: .3 } };
const response = (text = 'short', stopReason = 'stop') => ({ role: 'assistant', provider: 'test', model: 'model',
  content: [{ type: 'text', text }], stopReason, usage });
const batch = (id, chars = 1000) => ({ turnIndex: Number(id) || 0, timestamp: 0, assistantText: '',
  toolCalls: [{ toolCallId: String(id), toolName: 'bash', args: {}, resultText: 'x'.repeat(chars), isError: false }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function providerContext(resultFn = async () => response()) {
  const working = [], notifications = [], starts = [];
  const ctx = { model: { provider: 'test' }, ui: {
    notify: (...args) => notifications.push(args), setWorkingMessage: message => working.push(message),
  }, modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test', baseUrl: 'https://example.test', env: { TEST: 'yes' } }),
    getProvider: () => ({ stream(model, context, options) {
      const index = starts.length; starts.push({ model, context, options });
      return { async *[Symbol.asyncIterator]() {}, result: () => resultFn(index, options) };
    } }),
  } };
  return { ctx, working, notifications, starts };
}

async function harness({ config = {}, resultFn, branch = [] } = {}) {
  globalThis.__pruneConfig = { ...DEFAULT_CONFIG, enabled: true, ...config };
  const env = providerContext(resultFn);
  const handlers = {}, tools = {}, entries = [], messages = [], reports = [], widgets = [];
  let active = [];
  env.ctx.ui.setWidget = (id, value) => widgets.push([id, value]);
  env.ctx.ui.setStatus = () => {};
  const appendCustomEntry = (customType, data) => { entries.push({ type: 'custom', customType, data }); return 'entry'; };
  env.ctx.sessionManager = {
    getBranch: () => [...branch, ...entries], getSessionId: () => 'test-session', appendCustomEntry,
    appendCustomMessageEntry: (customType, content, display, details) => { messages.push({ customType, content, display, details }); return 'message'; },
    appendUsage: (...args) => reports.push(args),
  };
  const pi = { on: (name, handler) => { handlers[name] = handler; }, registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: appendCustomEntry, sendMessage: message => messages.push(message),
    getActiveTools: () => active, setActiveTools: next => { active = next; },
  };
  extension(pi);
  await handlers.session_start({}, env.ctx);
  const flush = (batches, options = {}) => pi.testFlush(env.ctx, { previewedBatches: batches, ...options });
  return { ...env, handlers, tools, entries, messages, reports, flush, capture: () => pi.testCapture(env.ctx),
    active: () => active, widgets, pi };
}
const frontier = h => h.entries.filter(e => e.customType === CUSTOM_TYPE_FRONTIER).at(-1)?.data;
const stats = h => h.entries.filter(e => e.customType === CUSTOM_TYPE_STATS).at(-1)?.data;

test('upstream defaults and provider auth forwarding survive integration', async () => {
  assert.equal(DEFAULT_CONFIG.pruneOn, 'agentic-auto');
  assert.equal(DEFAULT_CONFIG.batchingMode, 'agent-message');
  const h = await harness();
  assert.ok(h.active().includes('context_prune'));
  await h.flush([batch('1')]);
  assert.equal(h.starts[0].model.baseUrl, 'https://example.test');
  assert.deepEqual(h.starts[0].options.env, { TEST: 'yes' });
  assert.equal(h.reports.length, 1);
  assert.equal(stats(h).callCount, 1);
  assert.equal(stats(h).totalCost, usage.cost.total);
  assert.match(h.messages[0].content, /^<context-prune-summary>/);
  assert.ok(h.entries.some(e => e.customType === CUSTOM_TYPE_INDEX));
});

test('config migration adds fork settings without overriding persisted choices', async () => {
  assert.equal(persistedConfig.SETTINGS_PATH, join(temp, 'agent', 'context-prune', 'settings.json'));
  assert.deepEqual(await persistedConfig.loadConfig(), DEFAULT_CONFIG);
  await persistedConfig.saveConfig({ enabled: true, pruneOn: 'on-demand', batchingMode: 'turn', notifySkipped: false });
  const migrated = await persistedConfig.loadConfig();
  assert.equal(migrated.pruneOn, 'on-demand');
  assert.equal(migrated.batchingMode, 'turn');
  assert.equal(migrated.notifySkipped, false);
  assert.equal(migrated.minRawCharsToPrune, 700);
  assert.equal(migrated.summarizerConcurrency, 4);
  await persistedConfig.saveConfig({ ...DEFAULT_CONFIG, minRawCharsToPrune: 'bad', summarizerConcurrency: 'bad' });
  assert.deepEqual(await persistedConfig.loadConfig(), DEFAULT_CONFIG);
});

test('threshold boundary, disabled guard, and tiny-batch frontier without billing', async () => {
  for (const [threshold, chars, expectedCalls] of [[700, 699, 0], [700, 700, 1], [1000, 999, 0], [1000, 1000, 1], [0, 500, 1]]) {
    const h = await harness({ config: { minRawCharsToPrune: threshold } });
    const result = await h.flush([batch('1', chars)]);
    assert.equal(result.reason, expectedCalls ? 'flushed' : 'skipped-too-small');
    assert.equal(h.starts.length, expectedCalls);
    assert.equal(h.reports.length, expectedCalls);
    assert.equal(frontier(h).lastAttemptedToolCallId, '1');
    assert.equal(frontier(h).rawCharCount, chars);
    assert.equal(h.messages.length, expectedCalls);
    if (!expectedCalls) assert.equal(stats(h), undefined);
    assert.equal(h.working.at(-1), undefined);
    assert.match(h.working.at(-2), /1\/1 batches completed/);
  }
});

function sessionBranch(sizes, separateUsers = false) {
  return sizes.flatMap((size, i) => [
    ...(i === 0 || separateUsers ? [{ type: 'message', message: { role: 'user', content: 'request' } }] : []),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: String(i), name: 'bash', arguments: {} }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: String(i), content: [{ type: 'text', text: 'x'.repeat(size) }] } },
  ]);
}

test('threshold applies after upstream grouping and skipped results stay in context', async () => {
  const h = await harness({ branch: sessionBranch([400, 400]) });
  const grouped = h.capture();
  assert.equal(grouped.length, 1);
  const result = await h.flush(grouped);
  assert.equal(result.reason, 'flushed');
  assert.equal(h.starts.length, 1);
  assert.equal(result.toolCallCount, 2);
  assert.equal(h.capture().length, 0);
  const tinyBranch = sessionBranch([100]);
  const tiny = await harness({ branch: tinyBranch });
  await tiny.flush(tiny.capture());
  assert.equal(tiny.capture().length, 0, 'frontier prevents reattempt');
  const originalMessages = tinyBranch.map(e => e.message);
  const filtered = await tiny.handlers.context({ messages: originalMessages }, tiny.ctx);
  assert.equal((filtered?.messages ?? originalMessages).filter(m => m.role === 'toolResult').length,
    1, 'raw result is not pruned');
});

test('wrapped summary plus refs determines oversized skip and respects notifySkipped', async () => {
  for (const notifySkipped of [true, false]) {
    const h = await harness({ config: { minRawCharsToPrune: 0, notifySkipped }, resultFn: async () => response('s'.repeat(100)) });
    const result = await h.flush([batch('1', 101)]);
    assert.equal(result.reason, 'skipped-oversized');
    assert.ok(result.summaryCharCount > 101);
    assert.equal(h.messages.length, 0);
    assert.equal(h.reports.length, 1);
    assert.equal(stats(h).callCount, 1);
    assert.equal(h.notifications.filter(([, type]) => type === 'warning').length, Number(notifySkipped));
  }
});

test('mixed tiny and oversized tool response explains both reasons; mapping and progress preserved', async () => {
  const h = await harness({ config: { batchingMode: 'turn' }, branch: sessionBranch([100, 800], true),
    resultFn: async () => response('s'.repeat(1000)) });
  const progress = [];
  const result = await h.tools.context_prune.execute('prune', {}, undefined, update => progress.push(update), h.ctx);
  assert.equal(result.details.reason, 'skipped');
  assert.match(result.content[0].text, /or their summaries exceeded/);
  assert.equal(h.starts.length, 1);
  assert.equal(h.reports.length, 1);
  assert.equal(stats(h).callCount, 1);
  assert.match(h.working.at(-2), /2\/2 batches completed/);
  assert.equal(h.working.at(-1), undefined);
});

for (const limit of [1, 4, 7]) {
  test(`worker limit ${limit}, stable input order, usage and completion hooks`, async () => {
    const gates = Array.from({ length: 9 }, deferred);
    let active = 0, maxActive = 0;
    const { ctx, starts } = providerContext(i => {
      maxActive = Math.max(maxActive, ++active);
      return gates[i].promise.finally(() => { active--; });
    });
    const calls = [], completed = [];
    const pending = summarizeBatches(gates.map((_, i) => batch(String(i))), { ...DEFAULT_CONFIG, summarizerConcurrency: limit }, ctx,
      { onUsage: b => calls.push(b.toolCalls[0].toolCallId), onBatchComplete: i => completed.push(i) });
    await tick();
    assert.equal(starts.length, limit);
    // Complete the first wave in reverse order to catch order-vs-completion bugs.
    for (let i = limit - 1; i >= 0; i--) { gates[i].resolve(response(String(i))); await tick(); }
    for (let i = limit; i < gates.length; i++) { gates[i].resolve(response(String(i))); await tick(); }
    const results = await pending;
    assert.deepEqual(results.map(r => r.summaryText), gates.map((_, i) => String(i)));
    assert.equal(calls.length, 9);
    assert.equal(completed.length, 9);
    assert.equal(new Set(completed).size, 9);
    assert.equal(maxActive, limit);
    assert.equal(active, 0);
    if (limit > 1) assert.equal(completed[0], limit - 1);
  });
}

test('single-batch path forwards upstream usage and fork completion callbacks', async () => {
  const { ctx } = providerContext();
  const calls = [], completed = [];
  await summarizeBatches([batch('1')], DEFAULT_CONFIG, ctx, { onUsage: b => calls.push(b), onBatchComplete: i => completed.push(i) });
  assert.equal(calls.length, 1);
  assert.deepEqual(completed, [0]);
});

test('abort drains active workers, bills each once, does not start queued calls or advance frontier', async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const controller = new AbortController();
  const h = await harness({ resultFn: i => gates[i].promise });
  let settled = false;
  const pending = h.flush(Array.from({ length: 8 }, (_, i) => batch(String(i))), { signal: controller.signal })
    .then(result => { settled = true; return result; });
  await tick();
  assert.equal(h.starts.length, 4);
  controller.abort();
  gates[0].resolve(response('partial', 'aborted'));
  await tick();
  assert.equal(settled, false);
  assert.equal(stats(h), undefined, 'stats not persisted before remaining workers settle');
  for (let i = 1; i < 4; i++) gates[i].resolve(response('partial', 'aborted'));
  assert.equal((await pending).reason, 'aborted');
  assert.equal(h.starts.length, 4);
  assert.equal(h.reports.length, 4);
  assert.equal(stats(h).callCount, 4);
  assert.equal(frontier(h), undefined);
  assert.equal(h.messages.length, 0);
  assert.equal(h.working.at(-1), undefined);
});

test('failure counts later paid calls exactly once and leaves failed range retryable', async () => {
  const h = await harness({ resultFn: async i => response('short', i === 1 ? 'error' : 'stop') });
  const result = await h.flush([batch('0'), batch('1'), batch('2')]);
  assert.equal(result.batchCount, 1);
  assert.equal(frontier(h).lastAttemptedToolCallId, '0');
  assert.equal(h.reports.length, 3);
  assert.equal(stats(h).callCount, 3);
  assert.equal(h.messages.length, 1);
  assert.equal(h.working.at(-1), undefined);
  const failed = await harness({ resultFn: async () => response('short', 'error') });
  assert.equal((await failed.flush([batch('0')])).reason, 'summarizer-failed');
  assert.equal(failed.working.at(-1), undefined);
  assert.equal(stats(failed).callCount, 1);
});

test('manual sequential path retains full batch indexes and session delivery accounting', async () => {
  const h = await harness();
  const stages = [], textIndexes = [];
  const result = await h.flush([batch('0', 100), batch('1'), batch('2')], { delivery: 'session',
    onProgress: (i, total, b, stage) => stages.push([i, stage]),
    onBatchTextProgress: i => textIndexes.push(i),
  });
  assert.equal(result.reason, 'flushed');
  assert.deepEqual(stages, [[0, 'skipped'], [1, 'start'], [1, 'done'], [2, 'start'], [2, 'done']]);
  assert.deepEqual([...new Set(textIndexes)], [1, 2]);
  assert.equal(h.messages.filter(m => m.customType === CUSTOM_TYPE_SUMMARY).length, 2);
  assert.ok(h.messages.every(m => m.display === false));
  assert.equal(h.reports.length, 2);
  assert.equal(stats(h).callCount, 2);
  assert.equal(h.working.at(-1), undefined);
});

test('real /pruner now wiring stays sequential and clears progress widget', async () => {
  const gates = [deferred(), deferred()];
  const h = await harness({ config: { batchingMode: 'turn' }, branch: sessionBranch([1000, 1000], true),
    resultFn: i => gates[i].promise });
  let command;
  registerCommands({ registerCommand: (_, spec) => { command = spec; }, registerMessageRenderer() {} },
    { value: { ...DEFAULT_CONFIG, enabled: true, batchingMode: 'turn' } }, h.pi.testFlush, h.pi.testCapture,
    () => {}, () => stats(h) ?? { callCount: 0 }, {});
  const pending = command.handler('now', h.ctx);
  await tick();
  assert.equal(h.starts.length, 1, 'manual command starts only one call despite concurrency 4');
  gates[0].resolve(response());
  await tick();
  assert.equal(h.starts.length, 2);
  gates[1].resolve(response());
  await pending;
  assert.ok(h.widgets.some(([, value]) => value !== undefined));
  assert.equal(h.widgets.at(-1)[1], undefined);
  assert.equal(h.working.at(-1), undefined);
  assert.equal(stats(h).callCount, 2);
});

test('real /pruner now mixed skip notification states both reasons', async () => {
  const h = await harness({ config: { batchingMode: 'turn' }, branch: sessionBranch([100, 800], true),
    resultFn: async () => response('s'.repeat(1000)) });
  let command;
  registerCommands({ registerCommand: (_, spec) => { command = spec; }, registerMessageRenderer() {} },
    { value: { ...DEFAULT_CONFIG, enabled: true, batchingMode: 'turn' } }, h.pi.testFlush, h.pi.testCapture,
    () => {}, () => stats(h) ?? { callCount: 0 }, {});
  await command.handler('now', h.ctx);
  assert.match(h.notifications.at(-1)[0], /or their summaries exceeded/);
  assert.equal(h.widgets.at(-1)[1], undefined);
});

process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
