export async function runGateWithStableCodex({
  selection,
  supervisor,
  runCount,
  runPreflight,
  captureCodexIdentity,
  assertSameCodexIdentity,
  runOne,
  reportSuccess,
}) {
  await runPreflight();
  const codexIdentity = await captureCodexIdentity({
    ...selection,
    supervisor,
  });
  const results = [];
  for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
    results.push(await runOne(runNumber, codexIdentity.resolvedPath));
  }
  const postRunIdentity = await captureCodexIdentity({
    ...selection,
    supervisor,
    failureCode: "codex_version_changed",
  });
  assertSameCodexIdentity(codexIdentity, postRunIdentity);
  return reportSuccess(codexIdentity, results);
}
