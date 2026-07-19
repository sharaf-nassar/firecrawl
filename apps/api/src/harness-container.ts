export function containerRemovalCommand(
  runtime: string,
  containerName: string,
  removeVolumes: boolean = false,
): string[] {
  return [runtime, "rm", "-f", ...(removeVolumes ? ["-v"] : []), containerName];
}
