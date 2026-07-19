const DAY_MS = 24 * 60 * 60 * 1_000;

export function retentionDeadline(
  now: Date,
  configuredDays: number,
  zeroDataRetention: boolean,
): Date {
  const retentionDays = zeroDataRetention
    ? Math.min(configuredDays, 1)
    : configuredDays;
  return new Date(now.getTime() + retentionDays * DAY_MS);
}
