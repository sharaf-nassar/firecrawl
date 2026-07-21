import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureReplayCheckpoint,
  captureWithDeadline,
  resolveAppliedBrowserSettings,
  settleScrapeResources,
  SharedBrowserLifecycle,
} from './api';

function replaySettings() {
  return resolveAppliedBrowserSettings(
    { url: 'https://example.com', capture_replay_checkpoint: true },
    'actual-user-agent',
    { server: null, username: null, password: null },
  );
}

function createPostStorageCaptureHarness(options: {
  onStorageState?: () => void;
  lateTargetType?: string;
  omitLateTargetContext?: boolean;
  failLateTargetInventory?: boolean;
  writerReappearances?: number;
  writerNeverTerminates?: boolean;
  includeMixedUnknownTarget?: boolean;
}) {
  const commands: string[] = [];
  let storageStateMaterialized = false;
  let terminationAttempts = 0;
  let fingerprintReads = 0;
  const page = {
    viewportSize: () => ({ width: 1280, height: 800 }),
    url: () => 'https://example.com/final',
    title: async () => {
      fingerprintReads += 1;
      return 'title';
    },
    locator: () => ({
      evaluate: async () => {
        fingerprintReads += 1;
        return 'body';
      },
    }),
  };
  const session = {
    send: async (method: string) => {
      commands.push(method);
      if (method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            targetId: 'page-target',
            type: 'page',
            browserContextId: 'context-1',
          },
        };
      }
      if (method === 'Target.getTargets') {
        if (storageStateMaterialized && options.failLateTargetInventory) {
          throw new Error('secret target inventory failure');
        }
        const lateTargetVisible =
          storageStateMaterialized &&
          options.lateTargetType &&
          (options.writerNeverTerminates ||
            terminationAttempts <= (options.writerReappearances ?? 0));
        return {
          targetInfos: [
            {
              targetId: 'page-target',
              type: 'page',
              browserContextId: 'context-1',
            },
            ...(lateTargetVisible
              ? [
                  {
                    targetId: 'late-target',
                    type: options.lateTargetType,
                    ...(!options.omitLateTargetContext
                      ? { browserContextId: 'context-1' }
                      : {}),
                  },
                ]
              : []),
            ...(storageStateMaterialized && options.includeMixedUnknownTarget
              ? [
                  {
                    targetId: 'mixed-unknown-target',
                    type: 'unknown_writer',
                    browserContextId: 'context-1',
                  },
                ]
              : []),
          ],
        };
      }
      if (method === 'Storage.getUsageAndQuota') return { usage: 0 };
      if (method === 'Target.attachToTarget') {
        return { sessionId: 'late-writer-session' };
      }
      if (
        method === 'Target.sendMessageToTarget' ||
        method === 'Target.closeTarget'
      ) {
        terminationAttempts += 1;
        return { success: true };
      }
      return {};
    },
    detach: async () => undefined,
  };
  const context = {
    pages: () => [page],
    serviceWorkers: () => [],
    newCDPSession: async () => session,
    storageState: async () => {
      options.onStorageState?.();
      storageStateMaterialized = true;
      return { cookies: [], origins: [] };
    },
  };
  return {
    commands,
    context,
    page,
    fingerprintReads: () => fingerprintReads,
    terminationAttempts: () => terminationAttempts,
  };
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

test('bounds hung checkpoint cancellation and retires its browser', async () => {
  let recycled = 0;
  const startedAt = Date.now();

  await assert.rejects(
    captureWithDeadline(
      new Promise(() => undefined),
      10,
      async () => new Promise(() => undefined),
      async () => {
        recycled += 1;
      },
      10,
    ),
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      assert.equal(
        (error.errors[0] as { category?: string }).category,
        'checkpoint_timeout',
      );
      assert.equal((error.errors[1] as Error).name, 'CleanupTimeoutError');
      return true;
    },
  );

  assert.equal(recycled, 1);
  assert.ok(Date.now() - startedAt < 250);
});

test('rejects trusted Chromium quota before materializing indexedDB', async () => {
  const commands: string[] = [];
  let storageStateCalls = 0;
  const session = {
    send: async (method: string) => {
      commands.push(method);
      if (method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            targetId: 'page-target',
            type: 'page',
            browserContextId: 'context-1',
          },
        };
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            {
              targetId: 'page-target',
              type: 'page',
              browserContextId: 'context-1',
            },
          ],
        };
      }
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
    'Target.getTargetInfo',
    'Target.getTargets',
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
      send: async (method: string) => {
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'page-target',
              type: 'page',
              browserContextId: 'context-1',
            },
          };
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'page-target',
                type: 'page',
                browserContextId: 'context-1',
              },
              {
                targetId: 'service-worker-target',
                type: 'service_worker',
                browserContextId: 'context-1',
              },
            ],
          };
        }
        return {};
      },
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

test('rejects an origin overflow that races with page freezing', async () => {
  const origins = new Set(
    Array.from({ length: 128 }, (_, index) => `https://origin-${index}.example`),
  );
  const originState = {
    storageOrigins: origins,
    storageOriginsOverflow: false,
  };
  let freezeCalls = 0;
  const pages = [
    { viewportSize: () => ({ width: 1280, height: 800 }) },
    { viewportSize: () => ({ width: 1280, height: 800 }) },
  ];
  const context = {
    pages: () => pages,
    serviceWorkers: () => [],
    newCDPSession: async () => ({
      send: async (method: string) => {
        if (method === 'Page.setWebLifecycleState') {
          freezeCalls += 1;
          if (freezeCalls === 1) originState.storageOriginsOverflow = true;
        }
        return {};
      },
      detach: async () => undefined,
    }),
    storageState: async () => ({ cookies: [], origins: [] }),
  };

  await assert.rejects(
    captureReplayCheckpoint(
      context as never,
      pages[0] as never,
      replaySettings(),
      origins,
      () => originState.storageOriginsOverflow,
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(freezeCalls, 1);
});

test('rejects a 129th origin during storage-state materialization', async () => {
  const origins = new Set(
    Array.from({ length: 128 }, (_, index) => `https://origin-${index}.example`),
  );
  let overflow = false;
  const harness = createPostStorageCaptureHarness({
    onStorageState: () => {
      overflow = true;
    },
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      origins,
      () => overflow,
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.fingerprintReads(), 0);
});

test('rejects a new origin during storage-state materialization', async () => {
  const origins = new Set(['https://example.com']);
  const harness = createPostStorageCaptureHarness({
    onStorageState: () => {
      origins.add('https://late.example');
    },
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      origins,
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.fingerprintReads(), 0);
});

for (const targetType of [
  'worker',
  'shared_worker',
  'service_worker',
  'background_page',
]) {
  test(`terminates and rejects a late Chromium ${targetType} target`, async () => {
    const harness = createPostStorageCaptureHarness({ lateTargetType: targetType });

    await assert.rejects(
      captureReplayCheckpoint(
        harness.context as never,
        harness.page as never,
        replaySettings(),
        new Set(['https://example.com']),
      ),
      (error: unknown) =>
        error instanceof Error &&
        'category' in error &&
        error.category === 'checkpoint_unrepresentable',
    );
    assert.equal(harness.fingerprintReads(), 0);
    assert.ok(
      harness.commands.includes(
        targetType === 'worker' || targetType === 'shared_worker'
          ? 'Target.sendMessageToTarget'
          : 'Target.closeTarget',
      ),
    );
  });
}

test('rejects an unknown target after storage-state materialization', async () => {
  const harness = createPostStorageCaptureHarness({
    lateTargetType: 'unknown_writer',
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.fingerprintReads(), 0);
});

test('rejects a new page target after storage-state materialization', async () => {
  const harness = createPostStorageCaptureHarness({ lateTargetType: 'page' });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.fingerprintReads(), 0);
});

test('rejects an unattributable writer after storage-state materialization', async () => {
  const harness = createPostStorageCaptureHarness({
    lateTargetType: 'worker',
    omitLateTargetContext: true,
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.fingerprintReads(), 0);
  assert.equal(harness.terminationAttempts(), 0);
});

for (const targetType of ['page', 'unknown_writer']) {
  test(`rejects an unattributable ${targetType} target`, async () => {
    const harness = createPostStorageCaptureHarness({
      lateTargetType: targetType,
      omitLateTargetContext: true,
    });

    await assert.rejects(
      captureReplayCheckpoint(
        harness.context as never,
        harness.page as never,
        replaySettings(),
        new Set(['https://example.com']),
      ),
      (error: unknown) =>
        error instanceof Error &&
        'category' in error &&
        error.category === 'checkpoint_unrepresentable',
    );
    assert.equal(harness.fingerprintReads(), 0);
  });
}

test('terminates attributable writers before rejecting mixed targets', async () => {
  const harness = createPostStorageCaptureHarness({
    lateTargetType: 'worker',
    includeMixedUnknownTarget: true,
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.terminationAttempts(), 1);
  assert.equal(harness.fingerprintReads(), 0);
});

test('drains a respawned writer before rejecting the capture', async () => {
  const harness = createPostStorageCaptureHarness({
    lateTargetType: 'worker',
    writerReappearances: 1,
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.terminationAttempts(), 2);
  assert.equal(harness.fingerprintReads(), 0);
});

test('bounds cleanup of a surviving writer before rejecting capture', async () => {
  const harness = createPostStorageCaptureHarness({
    lateTargetType: 'worker',
    writerNeverTerminates: true,
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable',
  );
  assert.equal(harness.terminationAttempts(), 3);
  assert.equal(harness.fingerprintReads(), 0);
});

test('fails closed when late target inventory cannot be verified', async () => {
  const harness = createPostStorageCaptureHarness({
    failLateTargetInventory: true,
  });

  await assert.rejects(
    captureReplayCheckpoint(
      harness.context as never,
      harness.page as never,
      replaySettings(),
      new Set(['https://example.com']),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'category' in error &&
      error.category === 'checkpoint_unrepresentable' &&
      !error.message.includes('secret target inventory failure'),
  );
  assert.equal(harness.fingerprintReads(), 0);
});

for (const targetType of [
  'worker',
  'shared_worker',
  'service_worker',
  'background_page',
]) {
  test(`terminates and rejects Chromium ${targetType} targets`, async () => {
    const commands: string[] = [];
    let serviceWorkerDomainEnabled = false;
    let targetTerminated = false;
    let storageStateCalls = 0;
    const page = {
      viewportSize: () => ({ width: 1280, height: 800 }),
      url: () => 'https://example.com',
      title: async () => 'title',
      locator: () => ({ evaluate: async () => 'body' }),
    };
    const session = {
      send: async (method: string) => {
        commands.push(method);
        if (method === 'ServiceWorker.enable') {
          serviceWorkerDomainEnabled = true;
          return {};
        }
        if (
          method === 'ServiceWorker.stopAllWorkers' &&
          !serviceWorkerDomainEnabled
        ) {
          throw new Error('ServiceWorker domain not enabled');
        }
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'page-target',
              type: 'page',
              browserContextId: 'context-1',
            },
          };
        }
        if (method === 'Target.attachToTarget') {
          return { sessionId: 'writer-session' };
        }
        if (method === 'Target.sendMessageToTarget') {
          targetTerminated = true;
          return {};
        }
        if (method === 'Target.closeTarget') {
          if (targetType === 'worker' || targetType === 'shared_worker') {
            throw new Error('Target.closeTarget cannot terminate workers');
          }
          targetTerminated = true;
          return { success: true };
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'page-target',
                type: 'page',
                browserContextId: 'context-1',
              },
              ...(!targetTerminated
                ? [
                  {
                    targetId: 'writer-target',
                    type: targetType,
                    browserContextId: 'context-1',
                  },
                  ]
                : []),
            ],
          };
        }
        if (method === 'Storage.getUsageAndQuota') {
          return { usage: 0 };
        }
        return {};
      },
      detach: async () => undefined,
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
        error.category === 'checkpoint_unrepresentable',
    );
    if (targetType === 'worker' || targetType === 'shared_worker') {
      assert.ok(commands.includes('Target.attachToTarget'));
      assert.ok(commands.includes('Target.sendMessageToTarget'));
      assert.ok(!commands.includes('Target.closeTarget'));
    } else {
      assert.ok(commands.includes('Target.closeTarget'));
    }
    if (targetType === 'service_worker') {
      assert.ok(commands.includes('ServiceWorker.enable'));
      assert.ok(commands.includes('ServiceWorker.stopAllWorkers'));
    }
    assert.equal(storageStateCalls, 0);
  });
}

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

test('bounds hung resource closes, recycles once, and releases its permit', async () => {
  let recycled = 0;
  let released = 0;
  const startedAt = Date.now();

  await assert.rejects(
    settleScrapeResources(
      { close: async () => new Promise(() => undefined) },
      { close: async () => new Promise(() => undefined) },
      () => {
        released += 1;
      },
      undefined,
      async () => {
        recycled += 1;
      },
      10,
    ),
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      assert.deepEqual(
        error.errors.map(item => (item as Error).name),
        ['CleanupTimeoutError', 'CleanupTimeoutError'],
      );
      return true;
    },
  );

  assert.equal(recycled, 1);
  assert.equal(released, 1);
  assert.ok(Date.now() - startedAt < 250);
});

test('keeps checkpoint timeout primary when final resource cleanup also hangs', async () => {
  let captureError: unknown;
  try {
    await captureWithDeadline(
      new Promise(() => undefined),
      10,
      async () => {
        throw new Error('initial close failed');
      },
    );
  } catch (error) {
    captureError = error;
  }

  await assert.rejects(
    settleScrapeResources(
      { close: async () => new Promise(() => undefined) },
      null,
      () => undefined,
      captureError,
      async () => undefined,
      10,
    ),
    (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      assert.equal(
        (error.errors[0] as { category?: string }).category,
        'checkpoint_timeout',
      );
      return true;
    },
  );
});

test('retires a shared browser without killing concurrent leases', async () => {
  const terminated: string[] = [];
  const diagnostics: unknown[] = [];
  let generation = 0;
  const lifecycle = new SharedBrowserLifecycle(async () => {
    generation += 1;
    const id = `browser-${generation}`;
    return {
      browser: { id },
      terminate: async () => {
        terminated.push(id);
        if (id === 'browser-1') throw new Error('secret browser output');
      },
    };
  }, diagnostic => diagnostics.push(diagnostic));

  const first = await lifecycle.acquire();
  const concurrent = await lifecycle.acquire();
  assert.equal(first.browser, concurrent.browser);
  first.retire();

  const replacement = await lifecycle.acquire();
  assert.notEqual(replacement.browser, first.browser);
  first.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(terminated, []);

  concurrent.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(terminated, ['browser-1']);
  assert.deepEqual(diagnostics, [
    { category: 'browser_recycle_failed', errorName: 'Error' },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
  replacement.release();
});
