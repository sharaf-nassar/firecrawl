import { getArtifactStore } from "../lib/artifacts";

async function main(): Promise<void> {
  const store = getArtifactStore();
  if (!store) {
    throw new Error("Artifact store is not configured");
  }
  await store.health();
  process.stdout.write(`Artifact store healthy (${store.provider})\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
