import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureWithDeadline,
  resolveAppliedBrowserSettings,
  settleScrapeResources,
} from './api';

test('records applied static proxy truth instead of requested proxy metadata', () => {
  const settings = resolveAppliedBrowserSettings(
    {
      url: 'https://example.com',
      capture_replay_checkpoint: true,
      proxy_kind: 'auto',
      location: { languages: ['en-US'] },
    },
    'actual-user-agent',
    {
      server: 'http://proxy.internal:8080',
      username: 'server-user',
      password: 'server-password',
    },
  );
  assert.deepEqual(settings.proxy, {
    kind: 'basic',
    credentialRef: 'proxy-credential:playwright-service',
  });
  assert.deepEqual(settings.location, {
    country: 'us-generic',
    languages: ['en-US'],
  });
});

test('fails checkpoint capture when requested location is not applied exactly', () => {
  assert.throws(
    () =>
      resolveAppliedBrowserSettings(
        {
          url: 'https://example.com',
          capture_replay_checkpoint: true,
          location: { country: 'de', languages: ['de-DE', 'en-US'] },
        },
        'actual-user-agent',
        { server: null, username: null, password: null },
      ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
});

test('fails checkpoint capture when requested lockdown is not implemented', () => {
  assert.throws(
    () =>
      resolveAppliedBrowserSettings(
        {
          url: 'https://example.com',
          capture_replay_checkpoint: true,
          lockdown: true,
        },
        'actual-user-agent',
        { server: null, username: null, password: null },
      ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
});

test('bounds checkpoint capture with a typed deadline', async () => {
  await assert.rejects(
    captureWithDeadline(new Promise(() => undefined), 10),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_timeout',
  );
});

test('closes every resource, releases permit, and preserves ordered failures', async () => {
  const primary = new Error('primary');
  const pageClose = new Error('page close');
  const contextClose = new Error('context close');
  let released = 0;

  await assert.rejects(
    settleScrapeResources(
      { close: async () => Promise.reject(pageClose) },
      { close: async () => Promise.reject(contextClose) },
      () => {
        released += 1;
      },
      primary,
    ),
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      assert.deepEqual(error.errors, [primary, pageClose, contextClose]);
      return true;
    },
  );
  assert.equal(released, 1);
});
