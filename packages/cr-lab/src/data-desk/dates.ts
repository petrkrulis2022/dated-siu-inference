/** Calendar-date arithmetic on `YYYY-MM-DD` strings, all in UTC. Pure, so a window (a month, a quarter, 90 days) is the same on every machine and in every test. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(s: string): boolean {
  const m = DATE.exec(s);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

export function assertDate(s: string, label = "date"): string {
  if (!isDate(s))
    throw new TypeError(
      `${label} must be a real calendar date YYYY-MM-DD, got ${JSON.stringify(s)}`,
    );
  return s;
}

const ms = (s: string): number => Date.parse(`${assertDate(s)}T00:00:00Z`);
const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10);

export const addDays = (s: string, n: number): string => fmt(ms(s) + n * 86_400_000);
/** Whole days from `from` to `to` (`to` exclusive): the number of daily points in `[from, to)`. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((ms(to) - ms(from)) / 86_400_000);
/** Unix seconds at 00:00 UTC of the date. */
export const unixAt = (s: string): number => ms(s) / 1000;
export const firstOfMonth = (s: string): string => `${assertDate(s).slice(0, 7)}-01`;

/** The first day of the month `n` months before the month containing `s`. */
export function monthsBefore(s: string, n: number): string {
  const [y, m] = [Number(s.slice(0, 4)), Number(s.slice(5, 7))];
  const idx = y * 12 + (m - 1) - n;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
}

/** The last `months` COMPLETE calendar months before the one containing `asOf`, as a half-open window `[start, end)`; `end` is the first of asOf's month. */
export function completeMonthsWindow(asOf: string, months = 12): { start: string; end: string } {
  const end = firstOfMonth(asOf);
  return { start: monthsBefore(end, months), end };
}

/** Quarter `q` (1 to 4) of `year` as a half-open window `[start, end)`. */
export function quarterWindow(year: number, q: number): { start: string; end: string } {
  if (!Number.isInteger(q) || q < 1 || q > 4)
    throw new RangeError(`quarter must be 1 to 4, got ${q}`);
  const start = `${String(year).padStart(4, "0")}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
  return { start, end: monthsBefore(start, -3) };
}

/** The `months` calendar months of `[start, end)`, each as `{ month: "YYYY-MM", start, end }`, oldest first. */
export function monthsOf(
  start: string,
  end: string,
): { month: string; start: string; end: string }[] {
  const out: { month: string; start: string; end: string }[] = [];
  for (let s = firstOfMonth(start); ms(s) < ms(end); s = monthsBefore(s, -1))
    out.push({ month: s.slice(0, 7), start: s, end: monthsBefore(s, -1) });
  return out;
}
