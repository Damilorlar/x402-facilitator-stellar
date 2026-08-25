/**
 * Kafka webhook delivery (#117).
 *
 * The dispatcher is exercised with an injected kafkajs-shaped factory so no
 * broker is needed; what is under test is the contract: publish-only on the
 * request path, delivery owned by the consumer group, exponential backoff on
 * receiver failure, direct-mode degradation without brokers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookDispatcher, deliverWebhook } from '../src/webhooks/dispatcher.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('deliverWebhook', () => {
  test('retries transport failures with backoff until it succeeds', async () => {
    let attempts = 0;
    const result = await deliverWebhook({
      url: 'https://receiver.example/hook',
      body: { ok: 1 },
      maxAttempts: 4,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        if (attempts < 3) throw new Error('ECONNRESET');
        return { status: 200 };
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(result, { delivered: true, status: 200 });
  });

  test('gives up after maxAttempts and reports non-delivery', async () => {
    let attempts = 0;
    const warns = [];
    const result = await deliverWebhook({
      url: 'https://receiver.example/hook',
      body: {},
      maxAttempts: 3,
      baseBackoffMs: 1,
      warn: m => warns.push(m),
      fetchImpl: async () => {
        attempts++;
        throw new Error('ETIMEDOUT');
      },
    });
    assert.equal(attempts, 3);
    assert.equal(result.delivered, false);
    assert.ok(warns[0].includes('failed after 3'));
  });

  test('does not retry client-error statuses', async () => {
    let attempts = 0;
    await deliverWebhook({
      url: 'https://receiver.example/gone',
      body: {},
      maxAttempts: 5,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        return { status: 410 };
      },
    });
    assert.equal(attempts, 1);
  });

  test('retries server-error statuses', async () => {
    let attempts = 0;
    await deliverWebhook({
      url: 'https://receiver.example/flaky',
      body: {},
      maxAttempts: 2,
      baseBackoffMs: 1,
      fetchImpl: async () => {
        attempts++;
        return { status: 503 };
      },
    });
    assert.equal(attempts, 2);
  });
});

/** Builds a kafkajs-shaped double capturing producer sends and consumer runs. */
function fakeKafkaFactory() {
  const sent = [];
  let handler = null;
  const calls = { producerConnected: 0, subscribed: 0, consumerStarted: 0, stopped: 0 };
  const factory = () => ({
    producer() {
      return {
        connect: async () => calls.producerConnected++,
        disconnect: async () => {},
        send: async ({ topic, messages }) => sent.push({ topic, messages }),
      };
    },
    consumer({ groupId }) {
      assert.ok(groupId);
      return {
        subscribe: async () => calls.subscribed++,
        run: async ({ eachMessage }) => {
          handler = eachMessage;
          calls.consumerStarted++;
        },
        stop: async () => calls.stopped++,
      };
    },
  });
  factory.sent = sent;
  factory.calls = calls;
  /** Simulates a broker handing the consumer one message (JSON value). */
  factory.deliver = async value =>
    handler({ topic: 't', partition: 0, message: { value: Buffer.from(JSON.stringify(value)) } });
  /** Simulates a broker handing the consumer a raw (possibly invalid) payload. */
  factory.deliverRaw = async raw =>
    handler({ topic: 't', partition: 0, message: { value: Buffer.from(raw) } });
  return factory;
}

describe('kafka-backed dispatcher', () => {
  test('enqueue publishes to the topic and never delivers inline', async () => {
    const kafka = fakeKafkaFactory();
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      topic: 'webhooks',
      groupId: 'dispatchers',
      createKafka: kafka,
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
    });
    assert.equal(dispatcher.kind, 'kafka');

    dispatcher.enqueue({ type: 'settlement.completed', url: 'https://r.example/h' });
    // Give the publish microtask a tick.
    await sleep(10);

    assert.equal(kafka.sent.length, 1);
    assert.equal(kafka.sent[0].topic, 'webhooks');
    const record = JSON.parse(kafka.sent[0].messages[0].value.toString());
    assert.equal(record.type, 'settlement.completed');
    assert.equal(record.url, 'https://r.example/h');
    assert.ok(record.id && record.publishedAt);
    assert.equal(delivered, 0, 'delivery must not happen on the request path');

    await dispatcher.stop();
  });

  test('consumer group processes messages and delivers webhooks', async () => {
    const kafka = fakeKafkaFactory();
    const bodies = [];
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: kafka,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { status: 200 };
      },
    });

    await dispatcher.start();
    assert.equal(kafka.calls.consumerStarted, 1);

    await kafka.deliver({ id: 'e1', type: 'test', url: 'https://r.example/x' });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].id, 'e1');

    await dispatcher.stop();
    assert.equal(kafka.calls.stopped, 1);
  });

  test('a broker outage on publish falls back to direct delivery', async () => {
    const warns = [];
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: () => ({
        producer() {
          return {
            connect: async () => {},
            disconnect: async () => {},
            send: async () => {
              throw new Error('broker unreachable');
            },
          };
        },
        consumer() {
          return { subscribe: async () => {}, run: async () => {}, stop: async () => {} };
        },
      }),
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
      warn: m => warns.push(m),
    });

    dispatcher.enqueue({ type: 'test', url: 'https://r.example/fallback' });
    await sleep(20);

    assert.ok(warns.some(m => m.includes('publish failed')));
    assert.equal(delivered, 1, 'event must not be lost to a broker blip');
    await dispatcher.stop();
  });

  test('malformed consumer messages are dropped, not retried forever', async () => {
    const kafka = fakeKafkaFactory();
    let delivered = 0;
    const dispatcher = await createWebhookDispatcher({
      brokers: ['broker-1:9092'],
      createKafka: kafka,
      fetchImpl: async () => {
        delivered++;
        return { status: 200 };
      },
    });
    await dispatcher.start();

    await kafka.deliverRaw('{not json');
    assert.equal(delivered, 0, 'garbage must be dropped without delivery attempts');

    await dispatcher.stop();
  });
});

describe('direct-mode dispatcher (no Kafka configured)', () => {
  test('delivers off the critical path using the configured default url', async () => {
    const bodies = [];
    const dispatcher = await createWebhookDispatcher({
      url: 'https://default.example/hook',
      fetchImpl: async (_url, init) => {
        bodies.push({ url: _url, body: JSON.parse(init.body) });
        return { status: 200 };
      },
    });
    assert.equal(dispatcher.kind, 'direct');

    dispatcher.enqueue({ type: 'settlement.completed' });
    await sleep(10);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, 'https://default.example/hook');
    assert.equal(bodies[0].body.type, 'settlement.completed');

    // No default url and no per-event url: nothing is sent anywhere.
    const quiet = await createWebhookDispatcher({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { status: 200 };
      },
    });
    quiet.enqueue({ type: 'ignored' });
    await sleep(10);
    assert.equal(bodies.length, 1);
  });
});
