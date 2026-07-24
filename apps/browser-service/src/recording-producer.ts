import type { BrowserContext, Page } from "playwright";

export class RecordingProducerError extends Error {
  readonly category = "browser_unavailable" as const;
  readonly cleanupUnverified: boolean;

  constructor(
    message: string,
    options: ErrorOptions & { cleanupUnverified?: boolean } = {},
  ) {
    super(message, options);
    this.name = "RecordingProducerError";
    this.cleanupUnverified = options.cleanupUnverified ?? false;
  }
}

export type RecordingFrame = Readonly<{
  data: Buffer;
  timestamp: number;
  viewportWidth: number;
  viewportHeight: number;
}>;

export type RecordingProducer = Readonly<{
  snapshot(): Promise<Uint8Array>;
  subscribe(listener: (frame: RecordingFrame) => void): () => void;
  close(): Promise<void>;
}>;

type ProducerOptions = Readonly<{
  width: number;
  height: number;
  frameRate: number;
  maximumBytes: number;
  quality?: number;
}>;

type EncoderSnapshot =
  | { status: "ready"; bytes: Uint8Array }
  | { status: "overflow" }
  | { status: "unavailable" };

const encoderBootstrap = ({
  width,
  height,
  frameRate,
  maximumBytes,
}: Omit<ProducerOptions, "quality">) => {
  const NativeBlob = Blob;
  const NativeMediaRecorder = MediaRecorder;
  const NativeUint8Array = Uint8Array;
  const nativeAtob = atob.bind(globalThis);
  const nativeCreateImageBitmap = createImageBitmap.bind(globalThis);
  const nativeCreateElement = document.createElement.bind(document);
  const canvas = nativeCreateElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("recording canvas is unavailable");
  const mimeType = "video/webm;codecs=vp8";
  if (!NativeMediaRecorder.isTypeSupported(mimeType)) {
    throw new Error("VP8 WebM recording is unavailable");
  }
  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  if (
    videoTrack === undefined ||
    typeof (videoTrack as CanvasCaptureMediaStreamTrack).requestFrame !==
      "function"
  ) {
    throw new Error("manual recording frame capture is unavailable");
  }
  const canvasTrack = videoTrack as CanvasCaptureMediaStreamTrack;
  const recorder = new NativeMediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 600_000,
  });
  const chunks: Blob[] = [];
  let byteSize = 0;
  let overflow = false;
  let stopped = false;
  let drawSequence = 0;
  let snapshottedSequence = 0;
  let snapshotByteSize = 0;
  let eventTail = Promise.resolve();
  let snapshotTail = Promise.resolve<EncoderSnapshot>({
    status: "unavailable",
  });
  const waiters = new Set<() => void>();

  const settleWaiters = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  recorder.addEventListener("dataavailable", (event) => {
    eventTail = eventTail.then(() => {
      if (event.data.size !== 0) {
        const next = byteSize + event.data.size;
        if (!Number.isSafeInteger(next) || next > maximumBytes) {
          overflow = true;
          if (recorder.state !== "inactive") recorder.stop();
        } else {
          chunks.push(event.data);
          byteSize = next;
        }
      }
      settleWaiters();
    });
  });
  recorder.addEventListener("stop", () => {
    stopped = true;
    settleWaiters();
  });
  recorder.start(250);

  const encoder = {
    async draw(jpegBase64: string): Promise<void> {
      if (overflow || stopped) return;
      const binary = nativeAtob(jpegBase64);
      const bytes = new NativeUint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const bitmap = await nativeCreateImageBitmap(
        new NativeBlob([bytes], { type: "image/jpeg" }),
      );
      try {
        context.drawImage(bitmap, 0, 0, width, height);
        drawSequence += 1;
        canvasTrack.requestFrame();
      } finally {
        bitmap.close();
      }
    },
    snapshot(): Promise<EncoderSnapshot> {
      const run = async (): Promise<EncoderSnapshot> => {
      if (overflow) return { status: "overflow" };
      if (recorder.state === "inactive") return { status: "unavailable" };
        const requiredSequence = drawSequence;
        if (requiredSequence === 0) return { status: "unavailable" };
        if (requiredSequence > snapshottedSequence) {
          let progressed = false;
          for (let attempt = 0; attempt < 12; attempt += 1) {
            canvasTrack.requestFrame();
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            const delivered = new Promise<void>((resolve) =>
              waiters.add(resolve),
            );
            recorder.requestData();
            await delivered;
            await eventTail;
            if (overflow) return { status: "overflow" };
            if (byteSize > snapshotByteSize) {
              progressed = true;
              break;
            }
          }
          if (!progressed) return { status: "unavailable" };
          snapshottedSequence = requiredSequence;
          snapshotByteSize = byteSize;
        }
      if (overflow) return { status: "overflow" };
      const bytes = new NativeUint8Array(
        await new NativeBlob(chunks, { type: mimeType }).arrayBuffer(),
      );
      if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
        return { status: "unavailable" };
      }
      return { status: "ready", bytes };
      };
      const result = snapshotTail.then(run, run);
      snapshotTail = result;
      return result;
    },
    async stop(): Promise<void> {
      if (recorder.state !== "inactive") {
        const finished = new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
        });
        recorder.stop();
        await finished;
      }
      for (const track of stream.getTracks()) track.stop();
      chunks.length = 0;
      byteSize = 0;
    },
  };
  Object.defineProperty(globalThis, "__firecrawlRecordingEncoder", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(encoder),
  });
};

declare global {
  // Service-owned isolated encoder page only.
  var __firecrawlRecordingEncoder:
    | {
        draw(jpegBase64: string): Promise<void>;
        snapshot(): Promise<EncoderSnapshot>;
        stop(): Promise<void>;
      }
    | undefined;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export async function createChromiumRecordingProducer(
  target: Page,
  options: ProducerOptions,
): Promise<RecordingProducer> {
  positiveInteger(options.width, "width");
  positiveInteger(options.height, "height");
  positiveInteger(options.frameRate, "frameRate");
  positiveInteger(options.maximumBytes, "maximumBytes");
  const quality = options.quality ?? 70;
  if (!Number.isSafeInteger(quality) || quality < 0 || quality > 100) {
    throw new RangeError("quality must be an integer from 0 through 100");
  }
  const browser = target.context().browser();
  if (browser === null || !browser.isConnected()) {
    throw new RecordingProducerError(
      "persistent Chromium cannot create a recording encoder",
    );
  }

  let encoderContext: BrowserContext | undefined;
  let screencastStarted = false;
  let state: "starting" | "live" | "closing" | "closed" | "close_unverified" =
    "starting";
  let failure: unknown;
  let frameTail = Promise.resolve();
  let lastFrameTimestamp = Number.NEGATIVE_INFINITY;
  let closeFlight: Promise<void> | undefined;
  const subscribers = new Set<(frame: RecordingFrame) => void>();

  try {
    encoderContext = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: options.width, height: options.height },
    });
    const encoderPage = await encoderContext.newPage();
    if (
      encoderContext.pages().length !== 1 ||
      encoderContext.pages()[0] !== encoderPage ||
      encoderPage.url() !== "about:blank"
    ) {
      throw new RecordingProducerError(
        "recording encoder context is not isolated",
      );
    }
    await encoderPage.evaluate(encoderBootstrap, {
      width: options.width,
      height: options.height,
      frameRate: options.frameRate,
      maximumBytes: options.maximumBytes,
    });

    const onFrame = (frame: RecordingFrame) => {
      if (state !== "live" && state !== "starting") return;
      for (const subscriber of subscribers) {
        try {
          subscriber(frame);
        } catch {
          // A downstream stream cannot affect recording ownership.
        }
      }
      if (
        Number.isFinite(frame.timestamp) &&
        frame.timestamp - lastFrameTimestamp < 1 / options.frameRate
      ) {
        return;
      }
      lastFrameTimestamp = frame.timestamp;
      frameTail = frameTail.then(async () => {
        if (state !== "live" && state !== "starting") return;
        try {
          await encoderPage.evaluate(async (jpegBase64) => {
            const encoder = globalThis.__firecrawlRecordingEncoder;
            if (encoder === undefined) throw new Error("encoder is unavailable");
            await encoder.draw(jpegBase64);
          }, frame.data.toString("base64"));
        } catch (error) {
          failure ??= error;
        }
      });
    };
    await target.screencast.start({
      onFrame,
      size: { width: options.width, height: options.height },
      quality,
    });
    screencastStarted = true;
    state = "live";

    const close = (): Promise<void> => {
      if (closeFlight !== undefined) return closeFlight;
      closeFlight = (async () => {
        if (state === "closed") return;
        state = "closing";
        subscribers.clear();
        const failures: unknown[] = [];
        if (screencastStarted) {
          try {
            await target.screencast.stop();
            screencastStarted = false;
          } catch (error) {
            failures.push(error);
          }
        }
        await frameTail.catch((error) => failures.push(error));
        try {
          await encoderPage.evaluate(async () => {
            await globalThis.__firecrawlRecordingEncoder?.stop();
          });
        } catch (error) {
          failures.push(error);
        }
        try {
          await encoderContext!.close();
          encoderContext = undefined;
        } catch (error) {
          failures.push(error);
        }
        if (failures.length !== 0) {
          state = "close_unverified";
          throw new RecordingProducerError(
            "recording producer cleanup is unverified",
            {
              cause:
                failures.length === 1
                  ? failures[0]
                  : new AggregateError(failures),
              cleanupUnverified: true,
            },
          );
        }
        state = "closed";
      })();
      return closeFlight;
    };

    return Object.freeze({
      async snapshot(): Promise<Uint8Array> {
        if (state !== "live" || failure !== undefined) {
          throw new RecordingProducerError("recording producer is unavailable", {
            cause: failure,
          });
        }
        await frameTail;
        if (failure !== undefined) {
          throw new RecordingProducerError("recording frame delivery failed", {
            cause: failure,
          });
        }
        const snapshot = await encoderPage.evaluate(async () => {
          const encoder = globalThis.__firecrawlRecordingEncoder;
          if (encoder === undefined) return { status: "unavailable" } as const;
          return encoder.snapshot();
        });
        if (snapshot.status !== "ready") {
          throw new RecordingProducerError(
            snapshot.status === "overflow"
              ? "recording exceeds its byte limit"
              : "recording snapshot is unavailable",
          );
        }
        return snapshot.bytes;
      },
      subscribe(listener: (frame: RecordingFrame) => void): () => void {
        if (state !== "live" || typeof listener !== "function") {
          throw new RecordingProducerError("recording producer is unavailable");
        }
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      close,
    });
  } catch (error) {
    const failures = [error];
    if (screencastStarted) {
      try {
        await target.screencast.stop();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (encoderContext !== undefined) {
      try {
        await encoderContext.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    throw new RecordingProducerError("recording producer initialization failed", {
      cause:
        failures.length === 1 ? failures[0] : new AggregateError(failures),
      cleanupUnverified: failures.length !== 1,
    });
  }
}
