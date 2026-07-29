import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_HOOK_INPUT_BYTES = 256 * 1024;
const MAX_AUDIT_BYTES = 4 * 1024;

async function readBoundedInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function appendCanaryAudit(auditPath, auditToken, hookInput) {
  if (auditPath === undefined || auditToken === undefined) return;
  const handle = await open(
    auditPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o600,
  );
  try {
    const status = await handle.stat();
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size > MAX_AUDIT_BYTES
    ) {
      return;
    }
    const record = `${JSON.stringify({
      hookEventMatched: hookInput?.hook_event_name === "UserPromptSubmit",
      auditTokenMatched:
        typeof hookInput?.prompt === "string" &&
        hookInput.prompt.includes(auditToken),
    })}\n`;
    if (status.size + Buffer.byteLength(record, "utf8") <= MAX_AUDIT_BYTES) {
      await handle.writeFile(record);
    }
  } finally {
    await handle.close();
  }
}

const hookInput = await readBoundedInput();
await appendCanaryAudit(process.argv[2], process.argv[3], hookInput).catch(
  () => {},
);
