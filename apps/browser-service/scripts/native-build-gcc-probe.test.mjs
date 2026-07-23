import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  open,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCompilerEnvironment } from "./build-native.mjs";

const packageRoot = new URL("..", import.meta.url);
const lockPath = new URL(
  "../build/.atomic-directory-publication-build.lock",
  import.meta.url,
);
const maxCompilerCaptureBytes = 64 * 1024;

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stdio(fd) {
  return [
    "ignore",
    "pipe",
    "pipe",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    fd,
  ];
}

function captureBoundedPipe(stream, label) {
  if (stream === null) {
    throw new Error(`compiler ${label} pipe is unavailable`);
  }
  const chunks = [];
  let length = 0;
  let overflow = false;
  let streamError;
  let settle;
  const completion = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = () => {
    if (!settled) {
      settled = true;
      settle();
    }
  };
  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxCompilerCaptureBytes - length;
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      chunks.push(Buffer.from(retained));
      length += retained.length;
    }
    if (bytes.length > remaining) {
      overflow = true;
    }
  });
  stream.once("error", (error) => {
    streamError = error;
    finish();
  });
  stream.once("end", finish);
  stream.once("close", finish);
  stream.resume();
  return Object.freeze({
    async finish() {
      await completion;
      return Object.freeze({
        bytes: Buffer.concat(chunks, length),
        overflow,
        streamError,
      });
    },
  });
}

function captureCompilerOutput(child) {
  const stdout = captureBoundedPipe(child.stdout, "stdout");
  const stderr = captureBoundedPipe(child.stderr, "stderr");
  const completion = Promise.all([stdout.finish(), stderr.finish()]).then(
    ([stdoutResult, stderrResult]) =>
      Object.freeze({ stdout: stdoutResult, stderr: stderrResult }),
  );
  return Object.freeze({
    finish() {
      return completion;
    },
  });
}

function formatCompilerDiagnostics(capture) {
  return [
    `stdout=${JSON.stringify(capture.stdout.bytes.toString("utf8"))}`,
    `stderr=${JSON.stringify(capture.stderr.bytes.toString("utf8"))}`,
  ].join(" ");
}

function requireValidCompilerCapture(capture) {
  const failures = [];
  for (const [label, result] of Object.entries(capture)) {
    if (result.overflow) {
      failures.push(`${label} exceeded ${maxCompilerCaptureBytes} bytes`);
    }
    if (result.streamError !== undefined) {
      failures.push(`${label} pipe failed: ${result.streamError.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `compiler output capture failed: ${failures.join("; ")}; ` +
        formatCompilerDiagnostics(capture),
    );
  }
}

function statFields(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return {
    parent: Number(tail[1]),
    starttime: tail[19],
  };
}

function readClosedCmdline(pid) {
  const bytes = readFileSync(`/proc/${pid}/cmdline`);
  if (
    bytes.length === 0 ||
    bytes.length > 64 * 1024 ||
    bytes.at(-1) !== 0
  ) {
    throw new Error("process cmdline is not closed");
  }
  const args = bytes.subarray(0, -1).toString("utf8").split("\0");
  if (
    args.length === 0 ||
    args.length > 256 ||
    args.some((arg) => arg.length === 0 || arg.includes("\0"))
  ) {
    throw new Error("process cmdline grammar is invalid");
  }
  return Object.freeze({ bytes, args: Object.freeze(args) });
}

function bindProcessIdentity({
  pid,
  expectedParent,
  expectedExecutable,
  expectedHash,
  validateArgs,
}) {
  const fields = statFields(pid);
  const executable = realpathSync(`/proc/${pid}/exe`);
  const executableStatus = statSync(`/proc/${pid}/exe`, { bigint: true });
  const cmdline = readClosedCmdline(pid);
  if (
    fields.parent !== expectedParent ||
    executable !== expectedExecutable ||
    hash(`/proc/${pid}/exe`) !== expectedHash ||
    !executableStatus.isFile() ||
    !validateArgs(cmdline.args)
  ) {
    throw new Error("process identity is invalid");
  }
  return Object.freeze({
    pid,
    parent: fields.parent,
    starttime: fields.starttime,
    executable,
    executableHash: expectedHash,
    executableDev: executableStatus.dev,
    executableIno: executableStatus.ino,
    cmdline: Buffer.from(cmdline.bytes),
  });
}

function revalidateProcessIdentity(evidence) {
  const fields = statFields(evidence.pid);
  const executableStatus = statSync(`/proc/${evidence.pid}/exe`, {
    bigint: true,
  });
  const cmdline = readClosedCmdline(evidence.pid);
  if (
    fields.parent !== evidence.parent ||
    fields.starttime !== evidence.starttime ||
    realpathSync(`/proc/${evidence.pid}/exe`) !== evidence.executable ||
    hash(`/proc/${evidence.pid}/exe`) !== evidence.executableHash ||
    executableStatus.dev !== evidence.executableDev ||
    executableStatus.ino !== evidence.executableIno ||
    !cmdline.bytes.equals(evidence.cmdline)
  ) {
    throw new Error("bound process identity changed");
  }
}

function descendants(parent) {
  const matches = [];
  for (const leaf of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(leaf)) continue;
    const pid = Number(leaf);
    try {
      const fields = statFields(pid);
      if (fields.parent === parent) matches.push(pid);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  return matches;
}

function waitForChild(parent, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      for (const pid of descendants(parent)) {
        try {
          const executable = readlinkSync(`/proc/${pid}/exe`);
          if (executable.endsWith("/cc1")) {
            resolve({ pid, starttime: statFields(pid).starttime, executable });
            return;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            reject(error);
            return;
          }
        }
      }
      if (performance.now() >= deadline) {
        reject(new Error("timed out waiting for pinned cc1"));
      } else {
        setImmediate(inspect);
      }
    };
    inspect();
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function bounded(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function openWriter(path) {
  return new Promise((resolve, reject) => {
    open(path, constants.O_WRONLY | constants.O_NOFOLLOW, (error, fd) => {
      if (error) reject(error);
      else resolve(fd);
    });
  });
}

async function dispatchGccCleanup(state, effects) {
  state.cleanupErrors ??= [];
  const attempt = async (stage, effect, fallback) => {
    try {
      return await effect();
    } catch (error) {
      state.cleanupErrors.push(Object.freeze({ stage, error }));
      return fallback;
    }
  };
  if (!state.sourceReleased) {
    state.sourceReleased = true;
    await attempt("releaseSource", effects.releaseSource, undefined);
  }
  if (!state.exited && !state.gracefulAttempted) {
    state.gracefulAttempted = true;
    state.exited = await attempt("waitGraceful", effects.waitGraceful, false);
  }
  if (!state.exited && !state.termAttempted) {
    state.termAttempted = true;
    await attempt("term", effects.term, undefined);
    state.exited = await attempt("waitTerm", effects.waitTerm, false);
  }
  if (!state.exited && !state.killAttempted) {
    state.killAttempted = true;
    await attempt("kill", effects.kill, undefined);
    state.exited = await attempt("waitKill", effects.waitKill, false);
  }
  if (!state.residualChecked) {
    state.residualChecked = true;
    await attempt(
      "requireResidualGone",
      effects.requireResidualGone,
      undefined,
    );
  }
  if (!state.closed) {
    state.closed = true;
    await attempt("closeAll", effects.closeAll, undefined);
  }
  return state;
}

function createGccCleanupEffects(runtime) {
  return Object.freeze({
    releaseSource: () => runtime.releaseSource(),
    waitGraceful: () => runtime.waitGraceful(),
    term: () => runtime.term(),
    waitTerm: () => runtime.waitTerm(),
    kill: () => runtime.kill(),
    waitKill: () => runtime.waitKill(),
    requireResidualGone: () => runtime.requireResidualGone(),
    closeAll: () => runtime.closeAll(),
  });
}

function identity(path, expectedKind) {
  const status = lstatSync(path);
  if (
    status.uid !== process.getuid() ||
    status.nlink !== 1 ||
    (expectedKind === "fifo" ? !status.isFIFO() : !status.isFile())
  ) {
    throw new Error(`gcc fixture ${expectedKind} identity is unsafe`);
  }
  return Object.freeze({
    dev: status.dev,
    ino: status.ino,
    mode: status.mode,
    uid: status.uid,
    nlink: status.nlink,
    expectedKind,
  });
}

function unlinkVerified(path, saved) {
  const status = lstatSync(path);
  if (
    status.dev !== saved.dev ||
    status.ino !== saved.ino ||
    status.mode !== saved.mode ||
    status.uid !== saved.uid ||
    status.nlink !== saved.nlink ||
    (saved.expectedKind === "fifo" ? !status.isFIFO() : !status.isFile())
  ) {
    throw new Error(`gcc cleanup ${saved.expectedKind} identity changed`);
  }
  unlinkSync(path);
}

async function writeAll(fd, bytes) {
  const count = await new Promise((resolve, reject) => {
    import("node:fs").then(({ write }) =>
      write(fd, bytes, (error, written) => {
        if (error) reject(error);
        else resolve(written);
      }),
    );
  });
  if (count !== bytes.length) {
    throw new Error("gcc cleanup release write was short");
  }
}

async function waitForStopped(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = text.slice(text.lastIndexOf(")") + 2, -1).split(" ")[0];
    if (state === "T" || state === "t") return;
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for stopped gcc");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function runGccCleanupMatrixForTest() {
  const results = [];
  for (const exitAt of ["graceful", "term", "kill", "timeout"]) {
    const calls = [];
    const state = {
      sourceReleased: false,
      exited: false,
      gracefulAttempted: false,
      termAttempted: false,
      killAttempted: false,
      residualChecked: false,
      closed: false,
    };
    const effects = createGccCleanupEffects({
      async releaseSource() {
        calls.push("release");
      },
      async waitGraceful() {
        calls.push("graceful");
        return exitAt === "graceful";
      },
      term() {
        calls.push("term");
      },
      async waitTerm() {
        calls.push("wait-term");
        return exitAt === "term";
      },
      kill() {
        calls.push("kill");
      },
      async waitKill() {
        calls.push("wait-kill");
        return exitAt === "kill";
      },
      async requireResidualGone() {
        calls.push("residual");
      },
      async closeAll() {
        calls.push("close");
      },
    });
    await dispatchGccCleanup(state, effects);
    await dispatchGccCleanup(state, effects);
    results.push(Object.freeze({ exitAt, calls: Object.freeze(calls), state }));
  }
  return Object.freeze(results);
}

describe("direct compiler lock inheritance", () => {
  it("dispatches early, graceful, TERM, KILL, and timeout cleanup once", async () => {
    expect(createCompilerEnvironment.length).toBe(0);
    const environment = createCompilerEnvironment();
    expect(Object.getPrototypeOf(environment)).toBe(null);
    expect({ ...environment }).toEqual({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "1",
      ATOMIC_BUILD_LOCK_FD: "9",
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exactCapture = captureCompilerOutput({ stdout, stderr });
    stdout.end("stdout diagnostic");
    stderr.end("stderr diagnostic");
    const exactResult = await exactCapture.finish();
    requireValidCompilerCapture(exactResult);
    expect(exactResult.stdout.bytes.toString("utf8")).toBe(
      "stdout diagnostic",
    );
    expect(exactResult.stderr.bytes.toString("utf8")).toBe(
      "stderr diagnostic",
    );

    const overflowStdout = new PassThrough();
    const overflowStderr = new PassThrough();
    const overflowCapture = captureCompilerOutput({
      stdout: overflowStdout,
      stderr: overflowStderr,
    });
    overflowStdout.end(Buffer.alloc(maxCompilerCaptureBytes + 1, 0x61));
    overflowStderr.end("retained stderr");
    const overflowResult = await overflowCapture.finish();
    expect(overflowResult.stdout.bytes).toHaveLength(
      maxCompilerCaptureBytes,
    );
    expect(overflowResult.stdout.overflow).toBe(true);
    expect(() => requireValidCompilerCapture(overflowResult)).toThrow(
      /stdout exceeded 65536 bytes.*stderr="retained stderr"/,
    );

    expect(runGccCleanupMatrixForTest.length).toBe(0);
    for (const { exitAt, calls, state } of await runGccCleanupMatrixForTest()) {
      expect(calls.filter((value) => value === "release")).toHaveLength(1);
      expect(calls.filter((value) => value === "close")).toHaveLength(1);
      expect(calls.at(-2)).toBe("residual");
      expect(calls.at(-1)).toBe("close");
      if (exitAt === "timeout") expect(state.exited).toBe(false);
      expect(state.cleanupErrors).toEqual([]);
    }

    const calls = [];
    const failed = {
      sourceReleased: false,
      exited: false,
      gracefulAttempted: false,
      termAttempted: false,
      killAttempted: false,
      residualChecked: false,
      closed: false,
    };
    const failure = (stage) => () => {
      calls.push(stage);
      throw new Error(stage);
    };
    await dispatchGccCleanup(
      failed,
      createGccCleanupEffects({
        releaseSource: failure("releaseSource"),
        waitGraceful: failure("waitGraceful"),
        term: failure("term"),
        waitTerm: failure("waitTerm"),
        kill: failure("kill"),
        waitKill: failure("waitKill"),
        requireResidualGone: failure("requireResidualGone"),
        closeAll: failure("closeAll"),
      }),
    );
    expect(calls).toEqual([
      "releaseSource",
      "waitGraceful",
      "term",
      "waitTerm",
      "kill",
      "waitKill",
      "requireResidualGone",
      "closeAll",
    ]);
    expect(failed.cleanupErrors.map(({ stage }) => stage)).toEqual(calls);
  });

  it("runs real graceful, TERM, KILL, and timeout process cleanup", async () => {
    const inventory = JSON.parse(
      readFileSync(
        new URL(
          "../build/Release/atomic_directory_publication.inputs.sha256",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const compilerPath = realpathSync(inventory.compiler.path);
    expect(hash(compilerPath)).toBe(inventory.compiler.sha256);
    for (const exitAt of ["graceful", "term", "kill", "timeout"]) {
      const root = mkdtempSync(join(tmpdir(), `atomic-gcc-${exitAt}-`));
      const rootIdentity = lstatSync(root);
      const source = join(root, "source.fifo");
      const output = join(root, "probe.o");
      const held = openSync(
        lockPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      const acquired = spawnSync(
        "/usr/bin/flock",
        ["--exclusive", "--timeout", "60", "9"],
        { env: createCompilerEnvironment(), stdio: stdio(held) },
      );
      expect(acquired.status, acquired.stderr).toBe(0);
      const fifo = spawnSync(
        "/usr/bin/mkfifo",
        ["--mode=0600", "--", source],
        {
          cwd: packageRoot,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
          encoding: "utf8",
        },
      );
      expect(fifo.status).toBe(0);
      const leaves = new Map([["source", identity(source, "fifo")]]);
      let cancellationReader;
      let writer;
      let writerPromise = openWriter(source);
      const compiler = spawn(
        compilerPath,
        ["-x", "c", "-std=c11", "-c", source, "-o", output],
        {
          cwd: packageRoot,
          env: createCompilerEnvironment(),
          stdio: stdio(held),
        },
      );
      const compilerCapture = captureCompilerOutput(compiler);
      const compilerExit = waitForExit(compiler);
      const cc1 = await Promise.race([
        waitForChild(compiler.pid, 5000),
        compilerExit.then(() => {
          throw new Error("gcc exited before cc1 FIFO rendezvous");
        }),
      ]);
      writer = await bounded(writerPromise, 5000);
      if (writer === undefined) {
        throw new Error("writer did not rendezvous with real cc1");
      }
      writerPromise = undefined;
      let delayedExitObservation;
      if (exitAt === "kill" || exitAt === "timeout") {
        expect(compiler.kill("SIGSTOP")).toBe(true);
        await waitForStopped(compiler.pid, 2000);
      }
      const state = {
        sourceReleased: false,
        exited: false,
        gracefulAttempted: false,
        termAttempted: false,
        killAttempted: false,
        residualChecked: false,
        closed: false,
      };
      await dispatchGccCleanup(
        state,
        createGccCleanupEffects({
          async releaseSource() {
            if (writerPromise !== undefined) {
              cancellationReader = openSync(
                source,
                constants.O_RDONLY |
                  constants.O_NONBLOCK |
                  constants.O_NOFOLLOW,
              );
              writer = await writerPromise;
              writerPromise = undefined;
            }
            await writeAll(writer, Buffer.from("int atomic_gcc_probe;\n"));
            if (exitAt === "graceful") {
              closeSync(writer);
              writer = undefined;
            }
          },
          async waitGraceful() {
            return (
              (await bounded(
                compilerExit,
                exitAt === "graceful" ? 5000 : 50,
              )) !== undefined
            );
          },
          term() {
            if (writer !== undefined) {
              closeSync(writer);
              writer = undefined;
            }
            compiler.kill("SIGTERM");
          },
          async waitTerm() {
            return (
              (await bounded(compilerExit, exitAt === "term" ? 2000 : 50)) !==
              undefined
            );
          },
          kill() {
            compiler.kill("SIGKILL");
          },
          async waitKill() {
            if (exitAt === "timeout") {
              delayedExitObservation = new Promise((resolve, reject) => {
                setTimeout(() => compilerExit.then(resolve, reject), 100);
              });
              return (
                (await bounded(delayedExitObservation, 10)) !== undefined
              );
            }
            return (await bounded(compilerExit, 2000)) !== undefined;
          },
          async requireResidualGone() {
            expect(await bounded(compilerExit, 2000)).toBeDefined();
            if (delayedExitObservation !== undefined) {
              expect(
                await bounded(delayedExitObservation, 2000),
              ).toBeDefined();
            }
            const residualDeadline = performance.now() + 5000;
            for (;;) {
              let found = false;
              try {
                const status = statFields(cc1.pid);
                found = status.starttime === cc1.starttime;
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
              if (!found) break;
              if (performance.now() >= residualDeadline) {
                throw new Error("gcc cleanup retained cc1");
              }
              await new Promise((resolve) => setImmediate(resolve));
            }
            try {
              leaves.set("output", identity(output, "file"));
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
          },
          async closeAll() {
            const errors = [];
            const cleanup = (effect) => {
              try {
                effect();
              } catch (error) {
                errors.push(error);
              }
            };
            if (writer !== undefined) {
              cleanup(() => closeSync(writer));
              writer = undefined;
            }
            if (cancellationReader !== undefined) {
              cleanup(() => closeSync(cancellationReader));
              cancellationReader = undefined;
            }
            cleanup(() => closeSync(held));
            for (const [name, path] of [
              ["source", source],
              ["output", output],
            ]) {
              const saved = leaves.get(name);
              if (saved !== undefined) {
                cleanup(() => unlinkVerified(path, saved));
              } else {
                cleanup(() => {
                  try {
                    lstatSync(path);
                  } catch (error) {
                    if (error?.code === "ENOENT") return;
                    throw error;
                  }
                  throw new Error(`unexpected gcc fixture leaf: ${name}`);
                });
              }
            }
            cleanup(() => {
              const finalRoot = lstatSync(root);
              if (
                !finalRoot.isDirectory() ||
                finalRoot.dev !== rootIdentity.dev ||
                finalRoot.ino !== rootIdentity.ino ||
                finalRoot.mode !== rootIdentity.mode ||
                finalRoot.uid !== rootIdentity.uid ||
                finalRoot.nlink !== rootIdentity.nlink
              ) {
                throw new Error("gcc cleanup root identity changed");
              }
              rmdirSync(root);
            });
            if (errors.length > 0) {
              throw new AggregateError(errors, "gcc fixture cleanup failed");
            }
          },
        }),
      );
      const diagnostics = await compilerCapture.finish();
      requireValidCompilerCapture(diagnostics);
      const diagnosticMessage = formatCompilerDiagnostics(diagnostics);
      expect(state.cleanupErrors, diagnosticMessage).toEqual([]);
      expect(state.sourceReleased, diagnosticMessage).toBe(true);
      expect(state.gracefulAttempted, diagnosticMessage).toBe(true);
      expect(state.termAttempted, diagnosticMessage).toBe(
        exitAt !== "graceful",
      );
      expect(state.killAttempted, diagnosticMessage).toBe(
        exitAt === "kill" || exitAt === "timeout",
      );
      expect(state.exited, diagnosticMessage).toBe(exitAt !== "timeout");
      expect(() => lstatSync(root)).toThrow();
    }
  }, 20_000);

  it("pins real gcc and cc1 on fd 9 while source FIFO blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-gcc-fd9-"));
    const source = join(root, "source.fifo");
    const output = join(root, "probe.o");
    const rootIdentity = lstatSync(root);
    const held = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
    let writer;
    let writerPromise;
    let compiler;
    let compilerCapture;
    let compilerExit;
    let cc1Evidence;
    let cancellationReader;
    const leafIdentities = new Map();
    const cleanupState = {
      sourceReleased: false,
      exited: false,
      gracefulAttempted: false,
      termAttempted: false,
      killAttempted: false,
      residualChecked: false,
      closed: false,
    };
    try {
      const acquired = spawnSync(
        "/usr/bin/flock",
        ["--exclusive", "--timeout", "60", "9"],
        { env: createCompilerEnvironment(), stdio: stdio(held) },
      );
      expect(acquired.status).toBe(0);
      const heldIdentity = fstatSync(held);
      const lockIdentity = lstatSync(lockPath);
      expect(heldIdentity.isFile()).toBe(true);
      expect(heldIdentity.uid).toBe(process.getuid());
      expect(heldIdentity.mode & 0o7777).toBe(0o600);
      expect(heldIdentity.nlink).toBe(1);
      expect(heldIdentity.dev).toBe(lockIdentity.dev);
      expect(heldIdentity.ino).toBe(lockIdentity.ino);
      expect(stdio(held)[9]).toBe(held);
      const mkfifoPath = realpathSync("/usr/bin/mkfifo");
      const mkfifoStatus = lstatSync(mkfifoPath);
      const mkfifoHash = hash(mkfifoPath);
      expect(mkfifoPath).toBe("/usr/bin/mkfifo");
      expect(mkfifoStatus.isFile()).toBe(true);
      expect(mkfifoStatus.uid).toBe(0);
      expect(mkfifoStatus.mode & 0o022).toBe(0);
      const fifo = spawnSync(mkfifoPath, ["--mode=0600", "--", source], {
        cwd: packageRoot,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
        encoding: "utf8",
      });
      expect(fifo.status).toBe(0);
      expect(hash(mkfifoPath)).toBe(mkfifoHash);
      const fifoStatus = lstatSync(source);
      expect(fifoStatus.isFIFO()).toBe(true);
      expect(fifoStatus.uid).toBe(process.getuid());
      expect(fifoStatus.mode & 0o7777).toBe(0o600);
      expect(fifoStatus.nlink).toBe(1);
      leafIdentities.set("source", identity(source, "fifo"));
      const inventory = JSON.parse(
        readFileSync(
          new URL(
            "../build/Release/atomic_directory_publication.inputs.sha256",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const compilerPath = realpathSync(inventory.compiler.path);
      expect(hash(compilerPath)).toBe(inventory.compiler.sha256);
      const compilerArgv = [
        compilerPath,
        "-x",
        "c",
        "-std=c11",
        "-c",
        source,
        "-o",
        output,
      ];
      writerPromise = openWriter(source);
      compiler = spawn(
        compilerPath,
        compilerArgv.slice(1),
        {
          cwd: packageRoot,
          env: createCompilerEnvironment(),
          stdio: stdio(held),
        },
      );
      compilerCapture = captureCompilerOutput(compiler);
      compilerExit = waitForExit(compiler);
      const compilerEvidence = bindProcessIdentity({
        pid: compiler.pid,
        expectedParent: process.pid,
        expectedExecutable: compilerPath,
        expectedHash: inventory.compiler.sha256,
        validateArgs: (args) =>
          JSON.stringify(args) === JSON.stringify(compilerArgv),
      });
      const cc1 = await Promise.race([
        waitForChild(compiler.pid, 5000),
        compilerExit.then(() => {
          throw new Error("gcc exited before cc1 FIFO rendezvous");
        }),
      ]);
      cc1Evidence = cc1;
      writer = await bounded(writerPromise, 5000);
      if (writer === undefined) {
        throw new Error("writer did not rendezvous with real cc1");
      }
      writerPromise = undefined;

      expect(cc1.executable).toMatch(/\/cc1$/);
      const attestedCc1 = inventory.subtools.find(
        (entry) => entry.name === "cc1",
      );
      expect(realpathSync(cc1.executable)).toBe(attestedCc1.path);
      expect(hash(cc1.executable)).toBe(attestedCc1.sha256);
      const cc1BoundEvidence = bindProcessIdentity({
        pid: cc1.pid,
        expectedParent: compiler.pid,
        expectedExecutable: attestedCc1.path,
        expectedHash: attestedCc1.sha256,
        validateArgs: (args) =>
          realpathSync(args[0]) === attestedCc1.path &&
          args.filter((arg) => arg === source).length === 1,
      });
      const lock = fstatSync(held);
      for (const pid of [compiler.pid, cc1.pid]) {
        const inherited = statSync(`/proc/${pid}/fd/9`);
        expect(inherited.dev).toBe(lock.dev);
        expect(inherited.ino).toBe(lock.ino);
        const flags = Number.parseInt(
          readFileSync(`/proc/${pid}/fdinfo/9`, "utf8").match(
            /^flags:\s+([0-7]+)$/m,
          )[1],
          8,
        );
        expect(flags & 0o2000000).toBe(0);
      }

      revalidateProcessIdentity(compilerEvidence);
      revalidateProcessIdentity(cc1BoundEvidence);
      const contender = openSync(
        lockPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const blocked = spawnSync(
          "/usr/bin/flock",
          ["--exclusive", "--nonblock", "9"],
          {
            env: createCompilerEnvironment(),
            stdio: stdio(contender),
          },
        );
        expect(blocked.status).not.toBe(0);
      } finally {
        closeSync(contender);
      }

      const sourceBytes = Buffer.from("int atomic_fd9_probe;\n");
      expect(
        await new Promise((resolve, reject) => {
          import("node:fs").then(({ write }) =>
            write(writer, sourceBytes, (error, count) => {
              if (error) reject(error);
              else resolve(count);
            }),
          );
        }),
      ).toBe(sourceBytes.length);
      closeSync(writer);
      writer = undefined;
      cleanupState.sourceReleased = true;
      const result = await compilerExit;
      const diagnostics = await compilerCapture.finish();
      requireValidCompilerCapture(diagnostics);
      cleanupState.exited = true;
      expect(result, formatCompilerDiagnostics(diagnostics)).toEqual({
        code: 0,
        signal: null,
      });
      const outputStatus = statSync(output);
      expect(outputStatus.isFile()).toBe(true);
      expect(outputStatus.size).toBeGreaterThan(0);
      const elf = readFileSync(output);
      expect(elf.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(elf.readUInt16LE(16)).toBe(1);
      leafIdentities.set("output", identity(output, "file"));
      expect(() => statFields(cc1.pid)).toThrow();
    } finally {
      await dispatchGccCleanup(cleanupState, createGccCleanupEffects({
        async releaseSource() {
          if (writerPromise !== undefined) {
            if (cancellationReader === undefined) {
              cancellationReader = openSync(
                source,
                constants.O_RDONLY |
                  constants.O_NONBLOCK |
                  constants.O_NOFOLLOW,
              );
            }
            writer = await writerPromise;
            writerPromise = undefined;
          }
          if (writer !== undefined) {
            const sourceBytes = Buffer.from("int atomic_fd9_probe;\n");
            await writeAll(writer, sourceBytes);
            closeSync(writer);
            writer = undefined;
          }
        },
        async waitGraceful() {
          if (compilerExit === undefined) return true;
          return (await bounded(compilerExit, 5000)) !== undefined;
        },
        term() {
          if (compiler !== undefined) compiler.kill("SIGTERM");
        },
        async waitTerm() {
          if (compilerExit === undefined) return true;
          return (await bounded(compilerExit, 2000)) !== undefined;
        },
        kill() {
          if (compiler !== undefined) compiler.kill("SIGKILL");
        },
        async waitKill() {
          if (compilerExit === undefined) return true;
          return (await bounded(compilerExit, 2000)) !== undefined;
        },
        async requireResidualGone() {
          const deadline = performance.now() + 5000;
          for (;;) {
            let found = false;
            for (const leaf of readdirSync("/proc")) {
              if (!/^[1-9][0-9]*$/.test(leaf)) continue;
              const pid = Number(leaf);
              try {
                if (
                  (cc1Evidence !== undefined &&
                    pid === cc1Evidence.pid &&
                    statFields(pid).starttime === cc1Evidence.starttime) ||
                  readFileSync(`/proc/${pid}/cmdline`).includes(source)
                ) {
                  found = true;
                  break;
                }
              } catch (error) {
                if (error?.code !== "ENOENT" && error?.code !== "EACCES") {
                  throw error;
                }
              }
            }
            if (!found) return;
            if (performance.now() >= deadline) {
              throw new Error("residual gcc/cc1 identity remained live");
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
        },
        async closeAll() {
          const errors = [];
          const cleanup = (effect) => {
            try {
              effect();
            } catch (error) {
              errors.push(error);
            }
          };
          if (writer !== undefined) {
            cleanup(() => closeSync(writer));
            writer = undefined;
          }
          if (cancellationReader !== undefined) {
            cleanup(() => closeSync(cancellationReader));
            cancellationReader = undefined;
          }
          cleanup(() => closeSync(held));
          for (const [name, path] of [
            ["source", source],
            ["output", output],
          ]) {
            const saved = leafIdentities.get(name);
            if (saved !== undefined) {
              cleanup(() => unlinkVerified(path, saved));
            } else {
              cleanup(() => {
                try {
                  lstatSync(path);
                } catch (error) {
                  if (error?.code === "ENOENT") return;
                  throw error;
                }
                throw new Error(`unexpected gcc fixture leaf: ${name}`);
              });
            }
          }
          cleanup(() => {
            const finalRoot = lstatSync(root);
            if (
              !finalRoot.isDirectory() ||
              finalRoot.dev !== rootIdentity.dev ||
              finalRoot.ino !== rootIdentity.ino ||
              finalRoot.mode !== rootIdentity.mode ||
              finalRoot.uid !== rootIdentity.uid ||
              finalRoot.nlink !== rootIdentity.nlink
            ) {
              throw new Error("gcc cleanup root identity changed");
            }
            rmdirSync(root);
          });
          if (errors.length > 0) {
            throw new AggregateError(errors, "gcc fixture cleanup failed");
          }
        },
      }));
      if (compilerCapture !== undefined) {
        try {
          requireValidCompilerCapture(await compilerCapture.finish());
        } catch (error) {
          cleanupState.cleanupErrors.push(
            Object.freeze({ stage: "compilerOutput", error }),
          );
        }
      }
      if (cleanupState.cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupState.cleanupErrors.map(({ error }) => error),
          cleanupState.cleanupErrors
            .map(({ stage }) => stage)
            .join(", "),
        );
      }
    }
  }, 20_000);
});
