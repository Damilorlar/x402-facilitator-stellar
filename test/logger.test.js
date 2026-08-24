import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, requestLogger } from '../src/logger.js';

test('masks Authorization as ***', () => {
  const out = redact({ authorization: 'Bearer s3cret-key', 'content-type': 'application/json' });
  assert.equal(out.authorization, '***');
  assert.equal(out['content-type'], 'application/json');
});

test('is case-insensitive on header names', () => {
  const out = redact({ Authorization: 'Bearer s3cret-key' });
  assert.equal(out.Authorization, '***');
});

test('masks cookie and set-cookie', () => {
  const out = redact({ cookie: 'session=abc', 'set-cookie': 'session=abc; HttpOnly' });
  assert.equal(out.cookie, '***');
  assert.equal(out['set-cookie'], '***');
});

test('masks any key ending in _secret, at any depth', () => {
  const out = redact({
    facilitator_secret: 'Sxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    nested: { api_secret: 'abc', keep: 'me' },
  });
  assert.equal(out.facilitator_secret, '***');
  assert.equal(out.nested.api_secret, '***');
  assert.equal(out.nested.keep, 'me');
});

test('leaves unrelated fields untouched', () => {
  const out = redact({ method: 'GET', path: '/verify', count: 3, ok: true, none: null });
  assert.deepEqual(out, { method: 'GET', path: '/verify', count: 3, ok: true, none: null });
});

test('does not mutate the input', () => {
  const input = { authorization: 'Bearer x' };
  redact(input);
  assert.equal(input.authorization, 'Bearer x');
});

test('requestLogger logs redacted headers and never the body, after the response finishes', async () => {
  const lines = [];
  const middleware = requestLogger(msg => lines.push(msg));

  let finishCallback;
  const req = { method: 'POST', path: '/verify', headers: { authorization: 'Bearer s3cret' } };
  const res = {
    statusCode: 200,
    on: (event, cb) => {
      if (event === 'finish') finishCallback = cb;
    },
  };

  await new Promise(resolve => {
    middleware(req, res, resolve);
  });

  assert.equal(lines.length, 0, 'must not log before the response finishes');
  finishCallback();

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.method, 'POST');
  assert.equal(logged.path, '/verify');
  assert.equal(logged.status, 200);
  assert.equal(logged.headers.authorization, '***');
  assert.equal('body' in logged, false);
});
