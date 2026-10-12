const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/nodeseek_checkin.js'), 'utf8');
const STATE = 'nodeseek.loon.v2.state';
const LOCK = 'nodeseek.loon.v2.lock';
const NOW = Date.parse('2026-10-12T01:00:00Z');
const cookie = 'session=TEST_ONLY';

function run(options = {}) {
  const store = options.store || new Map();
  const calls = { done: [], posts: [], notices: [], logs: [], reads: 0, writes: 0 };
  const timers = [];
  let callback;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = {
    Date: Clock,
    $loon: 'iPhone15,2 18.0 3.2.0(1000)',
    $argument: options.argument || '',
    $persistentStore: {
      read(key) { calls.reads++; return store.get(key) || null; },
      write(value, key) {
        calls.writes++;
        if (options.failWrites) return false;
        if (value == null) store.delete(key); else store.set(key, value);
        return true;
      }
    },
    $done(...args) { calls.done.push(args); },
    $notification: { post(...args) { calls.notices.push(args); } },
    console: { log(value) { calls.logs.push(value); } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    $httpClient: { post(request, cb) {
      calls.posts.push(request); callback = cb;
      if (options.throwPost) throw new Error('TEST_SECRET');
    } }
  };
  if ('device' in options) context.$loon = options.device;
  if (options.request) context.$request = options.request;
  if (options.clearThrows) context.clearTimeout = () => { throw new Error('unsupported'); };
  vm.runInNewContext(source, context, { timeout: 1000 });
  return {
    calls, store,
    reply(status, body, error = null) { callback(error, { status }, typeof body === 'string' ? body : JSON.stringify(body)); },
    expire() { timers.forEach(fn => fn()); }
  };
}
function credentials(extra = {}) {
  return new Map([[STATE, JSON.stringify({ cookie, userAgent: 'TEST_UA', lastDay: '', ...extra })]]);
}
function visit(cookieValue = cookie) {
  return { url: 'https://www.nodeseek.com/', headers: { Cookie: cookieValue, 'User-Agent': 'TEST_UA' } };
}

for (const device of ['Mac 3.2.0(1000)', 'iPad13,1 18.0 3.2.0(1000)', undefined, {}, 'unknown']) {
  for (const entry of ['cron', 'capture', 'clear']) {
    test(`device gate: ${String(device)} / ${entry}`, () => {
      const store = credentials();
      const before = JSON.stringify([...store]);
      const r = run({ store, device, request: entry === 'capture' ? visit() : null,
        argument: entry === 'clear' ? 'action=clear' : '' });
      assert.equal(r.calls.posts.length, 0);
      assert.equal(r.calls.reads, 0);
      assert.equal(r.calls.writes, 0);
      assert.equal(r.calls.notices.length, 0);
      assert.equal(r.calls.done.length, 1);
      assert.equal(JSON.stringify([...store]), before);
      assert.equal(JSON.stringify(r.calls.done[0]), entry === 'capture' ? '[{}]' : '[]');
    });
  }
}

test('iPhone capture saves locally, unchanged headers never returned', () => {
  const r = run({ request: visit() });
  assert.equal(JSON.parse(r.store.get(STATE)).cookie, cookie);
  assert.equal(JSON.stringify(r.calls.done), '[[{}]]');
  assert.equal(r.calls.posts.length, 0);
  assert.equal(r.calls.notices.length, 1);
});
test('updated credential is saved but repeated capture notification is throttled', () => {
  const r = run({ store: credentials({ lastCaptureNotice: NOW - 1000, lastDay: '2026-10-12' }), request: visit('session=NEW_TEST') });
  assert.equal(JSON.parse(r.store.get(STATE)).cookie, 'session=NEW_TEST');
  assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '');
  assert.equal(r.calls.notices.length, 0);
});
test('API visits and header injection are ignored', () => {
  for (const request of [{ ...visit(), url: 'https://www.nodeseek.com/api/attendance' }, visit('x=1\r\nInjected: yes')]) {
    const r = run({ request });
    assert.equal(r.store.size, 0);
    assert.equal(r.calls.done.length, 1);
  }
});
test('successful request completes without clearTimeout, late callbacks are ignored', () => {
  const r = run({ store: credentials() });
  const req = r.calls.posts[0];
  assert.equal(req.url, 'https://www.nodeseek.com/api/attendance?random=true');
  assert.equal(req['auto-redirect'], false);
  assert.equal(req['auto-cookie'], false);
  assert.equal(req.insecure, false);
  r.reply(200, { success: true });
  r.expire();
  r.reply(200, { success: true });
  assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '2026-10-12');
  assert.equal(r.store.has(LOCK), false);
  assert.equal(r.calls.done.length, 1);
  assert.equal(r.calls.notices.length, 1);
});
test('throwing clearTimeout cannot prevent cleanup', () => {
  const r = run({ store: credentials(), clearThrows: true });
  r.reply(200, { success: true });
  assert.equal(r.calls.done.length, 1);
  assert.equal(r.store.has(LOCK), false);
});
test('quiet daily skip and force override via object arguments', () => {
  const store = credentials({ lastDay: '2026-10-12' });
  const skipped = run({ store, argument: 'quiet=true' });
  assert.equal(skipped.calls.posts.length, 0);
  assert.equal(skipped.calls.notices.length, 0);
  const forced = run({ store, argument: { force: true, random: false } });
  assert.match(forced.calls.posts[0].url, /random=false$/);
  forced.reply(200, { success: true });
});
test('encoded arguments supported', () => {
  const r = run({ store: credentials({ lastDay: '2026-10-12' }), argument: 'force=%74rue&random=false&bad=%ZZ' });
  assert.equal(r.calls.posts.length, 1);
  r.reply(200, { success: true });
});
test('active lock prevents force; expired lock allows request', () => {
  const store = credentials();
  store.set(LOCK, JSON.stringify({ id: 'other', until: NOW + 10000 }));
  const r = run({ store, argument: 'force=true' });
  assert.equal(r.calls.posts.length, 0);
  assert.equal(JSON.parse(store.get(LOCK)).id, 'other');
  store.set(LOCK, JSON.stringify({ id: 'other', until: NOW - 1 }));
  const retried = run({ store });
  assert.equal(retried.calls.posts.length, 1);
  retried.reply(200, { success: true });
});
test('timeout completes once and late success does not mark the day', () => {
  const r = run({ store: credentials() });
  r.expire();
  r.reply(200, { success: true });
  assert.equal(r.calls.done.length, 1);
  assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '');
  assert.equal(r.store.has(LOCK), false);
});
for (const [status, body, error] of [
  [401, {}], [403, 'TEST_SECRET'], [302, {}], [429, {}], [500, {}],
  [200, '<html>TEST_SECRET</html>'], [200, []], [200, null],
  [200, { success: false, message: '今天已签到，但是验证失败' }],
  [200, { success: 'true' }], [200, {}, 'TEST_SECRET']
]) {
  test(`failure is not recorded or leaked: ${status} ${JSON.stringify(body)}`, () => {
    const r = run({ store: credentials(), argument: 'quiet=true' });
    r.reply(status, body, error);
    assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '');
    assert.equal(r.calls.done.length, 1);
    assert.equal(r.store.has(LOCK), false);
    assert.equal(r.calls.notices.length, 1);
    assert.doesNotMatch(JSON.stringify([r.calls.logs, r.calls.notices]), /TEST_SECRET|TEST_ONLY|TEST_UA/);
  });
}
test('explicit already-completed message is recorded', () => {
  const r = run({ store: credentials() });
  r.reply(200, { success: false, message: '今天已完成签到。' });
  assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '2026-10-12');
});
test('changed credentials during request cannot receive old completion record', () => {
  const r = run({ store: credentials() });
  r.store.set(STATE, JSON.stringify({ cookie: 'session=OTHER_ACCOUNT', lastDay: '' }));
  r.reply(200, { success: true });
  assert.equal(JSON.parse(r.store.get(STATE)).lastDay, '');
});
test('clearing during a request does not recreate credentials', () => {
  const r = run({ store: credentials() });
  const cleared = run({ store: r.store, argument: 'action=clear' });
  assert.equal(cleared.calls.posts.length, 0);
  r.reply(200, { success: true });
  assert.equal(r.store.has(STATE), false);
});
test('corrupt state and unavailable persistence stop before networking', () => {
  for (const raw of ['{broken', 'true', '[]', 'null']) {
    const r = run({ store: new Map([[STATE, raw]]) });
    assert.equal(r.calls.posts.length, 0);
    assert.equal(r.calls.done.length, 1);
  }
  const failed = run({ store: credentials(), failWrites: true });
  assert.equal(failed.calls.posts.length, 0);
  assert.equal(failed.calls.done.length, 1);
});
test('synchronous networking exception still releases lock', () => {
  const r = run({ store: credentials(), throwPost: true });
  r.expire();
  assert.equal(r.calls.done.length, 1);
  assert.equal(r.store.has(LOCK), false);
  assert.doesNotMatch(JSON.stringify(r.calls.notices), /TEST_SECRET/);
});
