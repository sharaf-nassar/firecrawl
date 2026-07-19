import { getArtifactStore } from "./artifacts";

type MonitorDiffArtifactBase = {
  url: string;
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  generatedAt: string;
};

export type MonitorDiffArtifact =
  | (MonitorDiffArtifactBase & {
      kind: "markdown";
      text: string;
      json: unknown;
    })
  | (MonitorDiffArtifactBase & {
      kind: "json";
      /** Per-field {previous, current} diff. */
      json: Record<string, { previous: unknown; current: unknown }>;
      /** Full current JSON extraction (the snapshot at this run). */
      snapshot: Record<string, unknown>;
      /**
       * Optional markdown diff sidecar. Populated only when the monitor's
       * formats requested both `"json"` and `"git-diff"` change-tracking
       * modes — in that case we run both diffs and report `changed` if
       * either path saw a change.
       */
      markdown?: {
        text: string;
        json: unknown;
      };
    });

const contentType = "application/json";

export function monitorDiffGcsKey(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  pageId: string;
}): string {
  return `monitors/${params.teamId}/${params.monitorId}/${params.checkId}/${params.pageId}.diff.json`;
}

function artifactBytes(artifact: MonitorDiffArtifact): {
  textBytes: number;
  jsonBytes: number;
} {
  const jsonBytes = Buffer.byteLength(JSON.stringify(artifact.json ?? null));
  let textBytes = 0;
  if (artifact.kind === "markdown") {
    textBytes = Buffer.byteLength(artifact.text);
  } else if (artifact.kind === "json" && artifact.markdown) {
    // Sidecar markdown diff (mixed-mode monitor) — count it so storage
    // accounting stays honest.
    textBytes = Buffer.byteLength(artifact.markdown.text);
  }
  return { textBytes, jsonBytes };
}

export async function saveMonitorDiffArtifact(
  key: string,
  artifact: MonitorDiffArtifact,
): Promise<{ textBytes: number; jsonBytes: number }> {
  const payload = JSON.stringify(artifact);
  const store = getArtifactStore();
  if (!store) {
    return artifactBytes(artifact);
  }
  await store.put({
    key,
    body: payload,
    contentType,
  });

  return artifactBytes(artifact);
}

export async function getMonitorDiffArtifact(
  key: string | null | undefined,
): Promise<MonitorDiffArtifact | null> {
  if (!key) return null;

  const store = getArtifactStore();
  if (!store) return null;
  try {
    const contents = await store.get(key);
    if (contents === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString());
    } catch {
      // Corrupt or truncated artifact — surface as "no diff" instead of
      // letting JSON.parse throw and break the entire check response.
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // An unexpected payload shape (e.g. number, array, null) was written
      // here; treat as missing rather than risk reading kind off a non-object.
      return null;
    }
    const asPartial = parsed as Partial<MonitorDiffArtifact>;
    // Backwards compat: historical artifacts predate the `kind` field and
    // are always markdown.
    if (!asPartial.kind) {
      return { ...(asPartial as any), kind: "markdown" } as MonitorDiffArtifact;
    }
    return asPartial as MonitorDiffArtifact;
  } catch (error) {
    throw error;
  }
}
