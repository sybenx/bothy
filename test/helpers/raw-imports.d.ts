// Vite's `?raw` import suffix (used by hibernation.test.ts to read
// wrangler.jsonc's own crontab as a string, so limits.ts CRON_TICKS_PER_DAY
// can be checked against the crontab it restates) has no ambient type on
// its own -- this is that declaration.
declare module "*?raw" {
  const content: string;
  export default content;
}
