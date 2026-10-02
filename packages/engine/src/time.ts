// Simulated-clock helpers. All times are ms epoch derived from ISO local
// datetimes interpreted in UTC — the simulation is timezone-free by design.

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocal(iso: string): number | null {
  const m = ISO_LOCAL.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map((x) => x ?? '') as [string, string, string, string, string, string];
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  const dt = new Date(t);
  if (
    dt.getUTCFullYear() !== +y ||
    dt.getUTCMonth() !== +mo - 1 ||
    dt.getUTCDate() !== +d ||
    dt.getUTCHours() !== +h ||
    dt.getUTCMinutes() !== +mi
  ) {
    return null;
  }
  return t;
}

export function formatLocal(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function addMinutes(t: number, minutes: number): number {
  return t + minutes * 60_000;
}

export function addDays(t: number, days: number): number {
  return t + days * 86_400_000;
}

export function dayStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function humanDay(t: number): string {
  return DAYS[new Date(t).getUTCDay()]!;
}

export function humanTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function humanDayTime(t: number): string {
  return `${humanDay(t)} ${humanTime(t)}`;
}

export function sameDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}
