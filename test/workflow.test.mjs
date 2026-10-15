import test from 'node:test';
import assert from 'node:assert/strict';
import { TemplateWorkflow, buildRecommendationTask, buildRewriteTask, validateRanking, countCharacters, calculateCost } from '../src/index.mjs';

const candidates = ['a', 'b', 'c', 'd'].map(key => ({ key, label: `模板${key}`, prompt: `Template ${key}\nPreserve structure and details.` }));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function clock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule: (fn, delay) => { timers.set(++next, { fn, at: time + delay }); return next; },
    cancel: id => timers.delete(id),
    async tick(ms) {
      const target = time + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      time = target; await flush();
    },
  };
}
function fixture(options = {}) {
  const time = clock(), calls = [], rewrites = [];
  const workflow = new TemplateWorkflow({ candidates, ...time,
    recommend: task => { calls.push(task); return { keys: ['a', 'b', 'c'] }; },
    rewrite: task => { rewrites.push(task); return { text: 'Rewritten whole text' }; }, ...options });
  return { workflow, time, calls, rewrites };
}
async function ready(f) { f.workflow.edit({ text: 'A user draft', images: ['image-one'] }); await f.time.tick(1001); }

test('waits strictly longer than 1 second and uses a shared 10 second start interval', async () => {
  const f = fixture(); f.workflow.edit({ text: 'first' });
  await f.time.tick(1000); assert.equal(f.calls.length, 0);
  await f.time.tick(1); assert.equal(f.calls.length, 1);
  f.workflow.changeContext({ mode: 'quick', page: 'design' });
  await f.time.tick(9999); assert.equal(f.calls.length, 1);
  await f.time.tick(1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].context.page, 'design');
});

test('serializes requests across entries, queues only the latest edit and discards stale results', async () => {
  const first = deferred(); let active = 0, peak = 0;
  const f = fixture({ recommend: async task => { f.calls.push(task); peak = Math.max(peak, ++active); try { return f.calls.length === 1 ? await first.promise : { keys: ['b', 'c', 'd'] }; } finally { active--; } } });
  f.workflow.edit({ text: 'one' }); await f.time.tick(1001);
  f.workflow.changeContext({ mode: 'quick', page: 'design' });
  f.workflow.edit({ text: 'two' }); f.workflow.edit({ text: 'latest' });
  await f.time.tick(15000); assert.equal(f.calls.length, 1);
  first.resolve({ keys: ['a', 'b', 'c'] }); await flush();
  assert.deepEqual(f.workflow.state.recommendations, []);
  await f.time.tick(0);
  assert.equal(peak, 1); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].text, 'latest');
  assert.deepEqual(f.workflow.state.recommendations.map(x => x.key), ['b', 'c', 'd']);
});

test('clear input hides current results and cancels queued work', async () => {
  const f = fixture(); await ready(f);
  f.workflow.edit({ text: '', images: [] }); await f.time.tick(20000);
  assert.deepEqual(f.workflow.state.recommendations, []); assert.equal(f.calls.length, 1);
});

test('scope and context changes invalidate pending responses without restoring old diagnostics', async () => {
  const pending = deferred(); const f = fixture({ recommend: () => pending.promise });
  f.workflow.edit({ text: 'draft' }); await f.time.tick(1001);
  f.workflow.setScope({ id: 'other', candidates }); f.workflow.changeContext({ mode: 'agent', page: 'design' });
  pending.resolve({ keys: ['a', 'b', 'c'] }); await flush();
  assert.deepEqual(f.workflow.state.recommendations, []);
  assert.equal(f.workflow.state.diagnostics.recommendation.lastResult, null);
});

test('late recommendation success or error never writes diagnostics into a new scope', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(); const f = fixture({ recommend: () => pending.promise });
    f.workflow.edit({ text: 'Synthetic input' }); await f.time.tick(1001);
    f.workflow.setScope({ id: 'new-scope', candidates: [] });
    if (fail) pending.reject(new Error('synthetic failure'));
    else pending.resolve({ keys: ['a', 'b', 'c'], metadata: { cost: { amount: 1, currency: 'UNIT', basis: 'reported' } } });
    await flush();
    assert.equal(f.workflow.state.scope, 'new-scope');
    assert.equal(f.workflow.state.diagnostics.recommendation.lastResult, null);
    assert.equal(f.workflow.state.diagnostics.recommendation.stage, 'idle');
    assert.equal(f.workflow.state.recommending, false);
  }
});

test('agent is eligible only in inspiration before its first send', async () => {
  const f = fixture(); f.workflow.changeContext({ mode: 'agent', page: 'inspiration' });
  await ready(f); assert.equal(f.calls.length, 1);
  assert.ok(f.workflow.send()); f.workflow.changeContext({ page: 'inspiration' });
  f.workflow.edit({ text: 'another' }); await f.time.tick(20000); assert.equal(f.calls.length, 1);
  f.workflow.changeContext({ mode: 'quick', page: 'design' }); await f.time.tick(1001); assert.equal(f.calls.length, 2);
});

test('input preparation suspends recommendation and send', async () => {
  const f = fixture(); f.workflow.setInputPreparing(true); f.workflow.edit({ text: 'draft' });
  await f.time.tick(10000); assert.equal(f.calls.length, 0); assert.equal(f.workflow.send(), null);
  f.workflow.setInputPreparing(false); await f.time.tick(1001); assert.equal(f.calls.length, 1);
});

test('tasks include every complete candidate and immutable current input and latest history', () => {
  const history = Array.from({ length: 8 }, (_, n) => ({ text: `old${n}`, createdAt: n, images: [{ url: `image${n}` }] }));
  const images = [{ url: 'current' }];
  const task = buildRecommendationTask({ candidates, text: 'current text', images, history, context: { mode: 'quick', page: 'inspiration', scope: 'x' } });
  assert.deepEqual(task.candidates.map(x => x.prompt), candidates.map(x => x.prompt));
  assert.deepEqual(task.history.map(x => x.text), ['old7', 'old6', 'old5', 'old4', 'old3']);
  images[0].url = 'changed'; history[7].text = 'changed';
  assert.equal(task.images[0].url, 'current'); assert.equal(task.history[0].text, 'old7');
  assert.equal('images' in task.history[0], false);
  assert.throws(() => { task.candidates[0].prompt = 'changed'; }, TypeError);
  assert.match(task.instructions, /all candidates/i);
});

test('ranking accepts ordered keys or full scores and returns three distinct results', () => {
  assert.deepEqual(validateRanking({ keys: ['d', 'b', 'a'] }, candidates).map(x => x.key), ['d', 'b', 'a']);
  assert.deepEqual(validateRanking({ scores: [{ key: 'a', score: 1 }, { key: 'b', score: 4 }, { key: 'c', score: 3 }, { key: 'd', score: 2 }] }, candidates).map(x => x.key), ['b', 'c', 'd']);
  const labelled = validateRanking({ keys: ['a', 'b', 'c'], labels: [{ key: 'a', label: '😀甲乙丙丁戊' }] }, candidates);
  assert.equal(labelled[0].label, '😀甲乙丙丁'); assert.equal(countCharacters(labelled[0].label), 5);
});

test('ranking rejects unknown, duplicate, missing and malformed results', () => {
  for (const invalid of [
    { keys: ['a', 'b'] }, { keys: ['a', 'a', 'c'] }, { keys: ['a', 'b', 'unknown'] },
    { keys: ['a', 'b', 'c', 'd'] }, { keys: ['a', 'b', 'c', 'c'] }, { keys: ['a', 'b', 'c'], scores: [] },
    { scores: [{ key: 'a', score: 1 }, { key: 'b', score: 2 }, { key: 'c', score: 3 }] },
    { scores: candidates.map(({ key }) => ({ key, score: NaN })) },
    { keys: ['a', 'b', 'c'], labels: [{ key: 'unknown', label: 'x' }] },
  ]) assert.throws(() => validateRanking(invalid, candidates));
});

test('recommendation failures stay silent and do not retry automatically', async () => {
  let calls = 0; const f = fixture({ recommend: () => { calls++; throw new Error('unavailable'); } });
  await ready(f); await f.time.tick(60000);
  assert.equal(calls, 1); assert.equal(f.workflow.state.error, '');
  assert.equal(f.workflow.state.diagnostics.recommendation.stage, 'failed');
});

test('apply uses click snapshot, locks edits/send/apply and fills the complete rewritten text', async () => {
  const pending = deferred(); const f = fixture({ rewrite: task => { f.rewrites.push(task); return pending.promise; } });
  await ready(f); assert.equal(await f.workflow.apply('unknown'), false);
  const applied = f.workflow.apply('b');
  assert.equal(f.workflow.edit({ text: 'blocked' }), false); assert.equal(f.workflow.send(), null);
  assert.equal(await f.workflow.apply('a'), false);
  assert.equal(f.rewrites[0].text, 'A user draft'); assert.deepEqual(f.rewrites[0].images, ['image-one']);
  assert.equal(f.rewrites[0].template.prompt, candidates[1].prompt);
  assert.match(f.rewrites[0].instructions, /length and structure/i);
  pending.resolve({ text: 'Entire result\nSecond line' }); assert.equal(await applied, true);
  assert.equal(f.workflow.state.text, 'Entire result\nSecond line'); assert.equal(f.workflow.state.focusVersion, 1);
  assert.deepEqual(f.workflow.state.images, ['image-one']);
  await f.time.tick(30000); assert.equal(f.calls.length, 1);
  f.workflow.edit({ text: 'next user edit' }); await f.time.tick(1001); assert.equal(f.calls.length, 2);
});

test('failed and oversized rewrites preserve input/images and allow explicit retry without truncation', async () => {
  let count = 0; const f = fixture({ maxRewriteLength: 5, rewrite: () => ++count === 1 ? { text: 'too long' } : { text: '😀done' } });
  await ready(f); assert.equal(await f.workflow.apply('a'), false);
  assert.equal(f.workflow.state.text, 'A user draft'); assert.deepEqual(f.workflow.state.images, ['image-one']);
  assert.equal(f.workflow.state.retryable, true); assert.ok(f.workflow.state.error);
  assert.equal(f.workflow.state.diagnostics.rewrite.lastResult.errorCode, 'REWRITE_TOO_LONG');
  assert.equal(await f.workflow.retryRewrite(), true); assert.equal(f.workflow.state.text, '😀done');
});

test('rewrite exceptions and empty output preserve input, and edit removes retry state', async () => {
  let attempt = 0; const f = fixture({ rewrite: () => { if (++attempt === 1) throw new Error('failed'); return { text: '   ' }; } });
  await ready(f); assert.equal(await f.workflow.apply('a'), false); assert.equal(await f.workflow.retryRewrite(), false);
  assert.equal(f.workflow.state.text, 'A user draft'); f.workflow.edit({ text: 'new draft' });
  assert.equal(f.workflow.state.retryable, false); assert.equal(await f.workflow.retryRewrite(), false);
});

test('scope switch invalidates an active rewrite and releases the current input', async () => {
  const pending = deferred(); const f = fixture({ rewrite: () => pending.promise }); await ready(f);
  const applied = f.workflow.apply('a'); f.workflow.setScope({ id: 'new', candidates });
  assert.equal(f.workflow.state.rewriting, false); assert.equal(f.workflow.edit({ text: 'new scope draft' }), true);
  pending.resolve({ text: 'old scope result' }); assert.equal(await applied, false);
  assert.equal(f.workflow.state.text, 'new scope draft'); assert.equal(f.workflow.state.focusVersion, 0);
});

test('dispose prevents any further updates or callbacks', async () => {
  const pending = deferred(); let updates = 0;
  const f = fixture({ recommend: () => pending.promise, onChange: () => updates++ });
  f.workflow.edit({ text: 'draft' }); await f.time.tick(1001); f.workflow.dispose();
  const snapshot = f.workflow.state, before = updates; pending.resolve({ keys: ['a', 'b', 'c'] }); await flush();
  assert.deepEqual(f.workflow.state, snapshot); assert.equal(updates, before);
  assert.equal(f.workflow.edit({ text: 'new' }), false); assert.equal(f.workflow.changeContext({ page: 'design' }), false);
  await f.time.tick(20000); assert.deepEqual(f.workflow.state, snapshot);
});

test('metadata retains generic usage/cost and measures elapsed time without retaining arbitrary fields', async () => {
  const pending = deferred(); const f = fixture({ recommend: () => pending.promise });
  f.workflow.edit({ text: 'draft' }); await f.time.tick(1001); await f.time.tick(25);
  pending.resolve({ keys: ['a', 'b', 'c'], metadata: { usage: { inputTokens: 100, outputTokens: 20 }, cost: { amount: 0.01, currency: 'UNIT' }, arbitrary: 'do not retain' } }); await flush();
  const last = f.workflow.state.diagnostics.recommendation.lastResult;
  assert.equal(last.durationMs, 25); assert.equal(last.metadata.usage.inputTokens, 100);
  assert.equal(last.metadata.arbitrary, undefined);
  assert.deepEqual(calculateCost({ inputTokens: 100, outputTokens: 20 }, { input: 2, output: 3, per: 100, currency: 'UNIT' }), { amount: 2.6, currency: 'UNIT', basis: 'estimated' });
});

test('rewrite task is independently usable with a full template', () => {
  const task = buildRewriteTask({ template: candidates[0], text: 'draft', images: ['reference'], maxLength: 123 });
  assert.equal(task.maxLength, 123); assert.equal(task.template.prompt, candidates[0].prompt);
  assert.ok(Object.isFrozen(task)); assert.match(task.instructions, /Do not truncate/);
});


test('scope swaps candidates and history atomically and never carries old scope material', async () => {
  const f = fixture({ history: [{ text: 'A previous draft', createdAt: 1 }] }); await ready(f);
  const other = ['x', 'y', 'z'].map(key => ({ key, label: key, prompt: `Generic ${key}` }));
  assert.throws(() => f.workflow.setScope({ id: 'invalid', candidates: [{ key: 'invalid' }] }));
  assert.equal(f.workflow.state.scope, 'default');
  f.workflow.setScope({ id: 'next', candidates: other });
  await f.time.tick(10000);
  assert.deepEqual(f.calls[1].candidates.map(item => item.key), ['x', 'y', 'z']);
  assert.deepEqual(f.calls[1].history, []);
  assert.equal(f.calls[1].context.scope, 'next');
  assert.deepEqual(f.workflow.state.recommendations, []);
});

test('length ceiling follows template baseline, accounts for current draft, and keeps unknown cost null', async () => {
  let task; const f = fixture({ rewrite: value => { task = value; return { text: 'short result' }; } });
  await ready(f); await f.workflow.apply('a');
  assert.equal(task.targetLength, countCharacters(candidates[0].prompt));
  assert.equal(task.maxLength, Math.max(60, Math.ceil(task.targetLength * 1.25) + 20));
  const g = fixture({ rewrite: value => { task = value; return { text: 'short result' }; } });
  g.workflow.edit({ text: 'A'.repeat(300) }); await g.time.tick(1001); await g.workflow.apply('a');
  assert.equal(task.maxLength, 300);
  assert.equal(g.workflow.state.diagnostics.rewrite.lastResult.metadata.cost, null);
  assert.equal(calculateCost({}, null), null);
});

test('one or two candidates require the exact available result count', () => {
  assert.equal(validateRanking({ keys: ['a'] }, candidates.slice(0, 1)).length, 1);
  assert.equal(validateRanking({ keys: ['b', 'a'] }, candidates.slice(0, 2)).length, 2);
  assert.throws(() => validateRanking({ keys: ['a'] }, candidates.slice(0, 2)));
});

test('clearing during an active request discards its response without scheduling another', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ recommend: () => { calls++; return pending.promise; } });
  f.workflow.edit({ text: 'A draft' }); await f.time.tick(1001);
  f.workflow.edit({ text: '', images: [] }); pending.resolve({ keys: ['a', 'b', 'c'] }); await flush();
  await f.time.tick(30000); assert.equal(calls, 1); assert.deepEqual(f.workflow.state.recommendations, []);
});

test('dispose prevents an active rewrite from filling or emitting', async () => {
  const pending = deferred(); let updates = 0;
  const f = fixture({ rewrite: () => pending.promise, onChange: () => updates++ }); await ready(f);
  const applied = f.workflow.apply('a'); f.workflow.dispose(); const state = f.workflow.state, count = updates;
  pending.resolve({ text: 'late result' }); assert.equal(await applied, false);
  assert.deepEqual(f.workflow.state, state); assert.equal(updates, count);
});


test('empty catalog stays hidden until an atomic scope load provides candidates', async () => {
  const f = fixture({ candidates: [] }); f.workflow.edit({ text: 'A draft' });
  await f.time.tick(20000); assert.equal(f.calls.length, 0); assert.deepEqual(f.workflow.state.recommendations, []);
  f.workflow.setScope({ id: 'loaded', candidates }); await f.time.tick(1001); assert.equal(f.calls.length, 1);
  f.workflow.setScope({ id: 'empty', candidates: [] }); await f.time.tick(20000);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.workflow.state.recommendations, []);
  assert.equal(f.workflow.state.diagnostics.recommendation.lastResult, null);
  assert.equal(f.workflow.state.diagnostics.rewrite.stage, 'idle');
});

test('send creates a draft without adding ungenerated text to recent history', async () => {
  const history = [{ text: 'Generated A', createdAt: 5 }]; const f = fixture({ history });
  await ready(f); f.workflow.send(); f.workflow.edit({ text: 'Unsent B' }); await f.time.tick(10000);
  assert.deepEqual(f.calls[1].history, history);
  f.workflow.setHistory([{ text: 'Generated B', createdAt: 10 }, ...history]); await f.time.tick(10000);
  assert.deepEqual(f.calls[2].history.map(x => x.text), ['Generated B', 'Generated A']);
});

test('cost and usage expose only generic fields and never count token subsets twice', async () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, reasoningTokens: 15, arbitrary: 999 };
  const cost = calculateCost(usage, { input: 2, output: 3, per: 100, currency: 'UNIT' });
  assert.deepEqual(cost, { amount: 2.6, currency: 'UNIT', basis: 'estimated' });
  for (const rates of [undefined, {}, { input: -1, output: 2, per: 1, currency: 'UNIT' }, { input: 1, output: 2, per: 0, currency: 'UNIT' }]) assert.equal(calculateCost(usage, rates), null);
  assert.equal(calculateCost({ inputTokens: NaN, outputTokens: 2 }, { input: 1, output: 2, per: 1, currency: 'UNIT' }), null);
  const f = fixture({ recommend: () => ({ keys: ['a', 'b', 'c'], metadata: { usage, cost: { amount: 4, currency: 'UNIT', basis: 'reported', source: 'discard' } } }) });
  await ready(f); const actual = f.workflow.state.diagnostics.recommendation.lastResult.metadata;
  assert.equal(actual.usage.cacheReadTokens, 70); assert.equal(actual.usage.reasoningTokens, 15); assert.equal(actual.usage.arbitrary, undefined);
  assert.deepEqual(actual.cost, { amount: 4, currency: 'UNIT', basis: 'reported' });
});


test('task instructions prioritize current intent and preserve reference details without invented additions', () => {
  const recommend = buildRecommendationTask({ candidates });
  assert.match(recommend.instructions, /Explicit current requirements take priority/);
  assert.match(recommend.instructions, /history only assists with preferences/);
  const rewrite = buildRewriteTask({ template: candidates[0] });
  assert.match(rewrite.instructions, /replace only the conflicting parts/);
  assert.match(rewrite.instructions, /Preserve the uploaded subject and its details/);
  assert.match(rewrite.instructions, /Do not add content/);
});

test('cost overflow and malformed mixed ranking formats fail safely', () => {
  assert.equal(calculateCost({ inputTokens: 1e308, outputTokens: 1 }, { input: 1e308, output: 1, per: 1, currency: 'UNIT' }), null);
  assert.throws(() => validateRanking({ keys: ['a', 'b', 'c'], scores: {} }, candidates));
  assert.throws(() => validateRanking({ keys: null, scores: candidates.map(({ key }) => ({ key, score: 1 })) }, candidates));
});
