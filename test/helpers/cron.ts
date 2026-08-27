// Standard 5-field cron frequency counter, just enough to answer "how
// many times a day does this crontab fire" for this project's own crons.
// Supports minute/hour fields with `*`, a bare number, `a-b` ranges,
// `*/N`/`a-b/N` steps, and comma lists. Day-of-month, month and
// day-of-week are required to be `*`: a calendar-dependent trigger (a
// specific weekday, say) doesn't have a single "ticks per day" figure to
// begin with, and bothy's crontab has never needed one.
function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let start = min;
    let end = max;
    if (range !== "*") {
      if (range?.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        start = a ?? min;
        end = b ?? max;
      } else {
        start = end = Number(range);
      }
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return [...values];
}

export function cronTicksPerDay(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cronTicksPerDay: expected a 5-field cron expression, got "${expr}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    throw new Error(
      `cronTicksPerDay: only minute/hour crons are supported (day/month/weekday must be "*") -- got "${expr}"`,
    );
  }
  return parseCronField(minute, 0, 59).length * parseCronField(hour, 0, 23).length;
}
