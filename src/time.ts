export type Recurrence = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export const RECURRENCES: Recurrence[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "yearly"];

interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallTime(ms: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Converts a wall-clock time in `timeZone` to a UTC epoch (ms). Handles DST by re-resolving the offset. */
export function wallToUtc(w: Wall, timeZone: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const seen = wallTime(guess, timeZone);
    const seenNaive = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const diff = naive - seenNaive;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** Next occurrence strictly after `after`, keeping the original wall-clock time in `timeZone`. */
export function nextOccurrence(dueAt: number, recurrence: Recurrence, timeZone: string, after = Date.now()): number {
  let next = dueAt;
  // Bounded loop: catches up if the bot was offline for a while.
  for (let i = 0; i < 100_000 && next <= after; i++) {
    next = step(next, recurrence, timeZone);
  }
  return next;
}

function step(ms: number, recurrence: Recurrence, timeZone: string): number {
  if (recurrence === "hourly") return ms + 3_600_000;
  const w = wallTime(ms, timeZone);
  const addDays = (n: number) => {
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + n));
    return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  };
  switch (recurrence) {
    case "daily":
      return wallToUtc(addDays(1), timeZone);
    case "weekly":
      return wallToUtc(addDays(7), timeZone);
    case "weekdays": {
      for (let n = 1; n <= 7; n++) {
        const c = addDays(n);
        const dow = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
        if (dow !== 0 && dow !== 6) return wallToUtc(c, timeZone);
      }
      throw new Error("unreachable");
    }
    case "monthly":
    case "yearly": {
      const months = recurrence === "monthly" ? 1 : 12;
      const total = w.month - 1 + months;
      const year = w.year + Math.floor(total / 12);
      const month = (total % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return wallToUtc({ ...w, year, month, day: Math.min(w.day, lastDay) }, timeZone);
    }
  }
}

export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(ms));
}

/** ISO-8601 with the zone's UTC offset, e.g. 2026-11-04T09:30:00+05:00. */
export function isoInZone(ms: number, timeZone: string): string {
  const w = wallTime(ms, timeZone);
  const offsetMin = Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Parses an ISO-8601 timestamp. One without an offset ("2026-11-05T09:00") is read as wall time in `timeZone`.
 * Returns NaN when unparseable.
 */
export function parseWhen(input: string, timeZone: string): number {
  const s = input.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return NaN;
  return wallToUtc(
    { year: +m[1], month: +m[2], day: +m[3], hour: +(m[4] ?? 9), minute: +(m[5] ?? 0), second: +(m[6] ?? 0) },
    timeZone,
  );
}
