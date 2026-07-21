import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureReplayCheckpoint,
  captureWithDeadline,
  resolveAppliedBrowserSettings,
  settleScrapeResources,
} from './api';

function replaySettings() {
  return resolveAppliedBrowserSettings(
    { url: 'https://example.com', capture_replay_checkpoint: true },
    'actual-user-agent',
    { server: null, username: null, password: null },
  );
}

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

test('cancels checkpoint work and closes writers when capture times out', async () => {
  let rejectCapture!: (error: Error) => void;
  let captureSettled = false;
  let writersClosed = false;
  const capture = new Promise<never>((_, reject) => {
    rejectCapture = reject;
  }).finally(() => {
    captureSettled = true;
  });

  await assert.rejects(
    captureWithDeadline(capture, 10, async () => {
      writersClosed = true;
      rejectCapture(new Error('capture cancelled by context close'));
    }),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_timeout',
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writersClosed, true);
  assert.equal(captureSettled, true);
});

test('keeps timeout primary when writer cancellation also fails', async () => {
  await assert.rejects(
    captureWithDeadline(new Promise(() => undefined), 10, async () => {
      throw new Error('context close failed');
    }),
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      assert.equal(
        (error.errors[0] as { category?: string }).category,
        'checkpoint_timeout',
      );
      assert.match((error.errors[1] as Error).message, /context close failed/);
      return true;
    },
  );
});

test('rejects trusted Chromium quota before materializing indexedDB', async () => {
  const commands: string[] = [];
  let storageStateCalls = 0;
  const session = {
    send: async (method: string) => {
      commands.push(method);
      if (method === 'Storage.getUsageAndQuota') {
        return {
          usage: 2_097_153,
          quota: 10_000_000,
          overrideActive: false,
          usageBreakdown: [],
        };
      }
      return {};
    },
    detach: async () => undefined,
  };
  const page = {
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const context = {
    pages: () => [page],
    serviceWorkers: () => [],
    newCDPSession: async () => session,
    storageState: async () => {
      storageStateCalls += 1;
      return { cookies: [], origins: [] };
    },
  };

  await assert.rejects(
    captureReplayCheckpoint(
      context as never,
      page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_too_large',
  );
  assert.equal(storageStateCalls, 0);
  assert.deepEqual(commands, [
    'Page.setWebLifecycleState',
    'Storage.getUsageAndQuota',
  ]);
});

test('rejects unexpected service-worker writers before storage capture', async () => {
  let storageStateCalls = 0;
  const page = { viewportSize: () => ({ width: 1280, height: 800 }) };
  const context = {
    pages: () => [page],
    serviceWorkers: () => [{}],
    newCDPSession: async () => ({
      send: async () => ({}),
      detach: async () => undefined,
    }),
    storageState: async () => {
      storageStateCalls += 1;
      return { cookies: [], origins: [] };
    },
  };

  await assert.rejects(
    captureReplayCheckpoint(
      context as never,
      page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(storageStateCalls, 0);
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
