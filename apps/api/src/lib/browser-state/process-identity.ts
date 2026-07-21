import { readFile } from "node:fs/promises";

interface BrowserStateProcessIdentity {
  pid: number;
  bootId: string;
  startTime: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readBootId(): Promise<string> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
    .trim()
    .replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(bootId)) {
    throw new Error("process boot identity is invalid");
  }
  return bootId;
}

export async function readBrowserStateProcessIdentity(
  pid = process.pid,
): Promise<BrowserStateProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("process identity is invalid");
  }
  const bootId = await readBootId();
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const endOfName = stat.lastIndexOf(")");
  const startTime = stat.slice(endOfName + 2).split(" ")[19];
  if (endOfName < 0 || !startTime || !/^\d+$/.test(startTime)) {
    throw new Error("process start identity is invalid");
  }
  return { pid, bootId, startTime };
}

export async function inspectBrowserStateProcessIdentity(
  expected: BrowserStateProcessIdentity,
): Promise<"live" | "dead" | "unknown"> {
  try {
    const actual = await readBrowserStateProcessIdentity(expected.pid);
    return actual.bootId === expected.bootId &&
      actual.startTime === expected.startTime
      ? "live"
      : "dead";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "dead";
    if (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? "")) {
      return "unknown";
    }
    return "unknown";
  }
}
