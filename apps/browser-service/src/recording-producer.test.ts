import { afterEach, describe, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";

import {
  RecordingProducerError,
  createChromiumRecordingProducer,
} from "./recording-producer.js";

const browsers: Browser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});

async function expectPlayableWebm(browser: Browser, bytes: Uint8Array) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(async (payload) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(
        new Blob([new Uint8Array(payload)], { type: "video/webm" }),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("WebM did not decode"));
        });
        await video.play();
        return {
          ready: video.readyState >= HTMLMediaElement.HAVE_METADATA,
          duration: video.duration,
        };
      } finally {
        URL.revokeObjectURL(video.src);
      }
    }, bytes);
  } finally {
    await context.close();
  }
}

async function waitForProducedFrames(
  producer: Awaited<ReturnType<typeof createChromiumRecordingProducer>>,
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let observed = 0;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`recording produced fewer than ${count} frames`));
    }, timeoutMs);
    const unsubscribe = producer.subscribe(() => {
      observed += 1;
      if (observed < count) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

describe("Chromium recording producer", () => {
  test(
    "captures playable active WebM across navigation without target pollution",
    async () => {
      const browser = await chromium.launch({ headless: true });
      browsers.push(browser);
      const targetContext = await browser.newContext({
        viewport: { width: 320, height: 240 },
      });
      const target = await targetContext.newPage();
      await target.setContent(
        "<style>body{margin:0;background:#111}div{width:80px;height:80px;" +
          "background:#f40;animation:m .4s infinite alternate linear}" +
          "@keyframes m{to{transform:translate(220px,140px);background:#09f}}" +
          "</style><div></div>",
      );

      const producer = await createChromiumRecordingProducer(target, {
        width: 320,
        height: 240,
        frameRate: 10,
        maximumBytes: 16 * 1024 * 1024,
      });
      expect(browser.contexts()).toHaveLength(2);
      expect(targetContext.pages()).toEqual([target]);

      await waitForProducedFrames(producer, 2);
      const first = await producer.snapshot();
      expect(Buffer.from(first).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
      expect((await expectPlayableWebm(browser, first)).ready).toBe(true);

      const navigatedFrame = waitForProducedFrames(producer, 1);
      await target.goto(
        "data:text/html,<body style=margin:0;background:%23027></body>",
      );
      await navigatedFrame;
      const second = await producer.snapshot();
      expect(second.byteLength).toBeGreaterThan(first.byteLength);
      expect((await expectPlayableWebm(browser, second)).ready).toBe(true);
      expect(targetContext.pages()).toEqual([target]);

      await producer.close();
      expect(browser.contexts()).toEqual([targetContext]);
      await targetContext.close();
    },
    30_000,
  );

  test(
    "enforces the production byte cap and still closes its isolated context",
    async () => {
      const browser = await chromium.launch({ headless: true });
      browsers.push(browser);
      const targetContext = await browser.newContext({
        viewport: { width: 320, height: 240 },
      });
      const target = await targetContext.newPage();
      await target.setContent(
        "<style>body{margin:0;background:#000;animation:x .05s infinite}" +
          "@keyframes x{to{background:#fff}}</style>",
      );
      const producer = await createChromiumRecordingProducer(target, {
        width: 320,
        height: 240,
        frameRate: 10,
        maximumBytes: 128,
      });

      await waitForProducedFrames(producer, 1);
      await expect(producer.snapshot()).rejects.toBeInstanceOf(
        RecordingProducerError,
      );
      await producer.close();
      expect(browser.contexts()).toEqual([targetContext]);
      await targetContext.close();
    },
    30_000,
  );
});
