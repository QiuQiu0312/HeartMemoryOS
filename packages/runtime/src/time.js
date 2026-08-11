import { RuntimeInvariantError } from "./errors.js";
import { epochMs, iso } from "./utils.js";

const FORMATTERS = new Map();

function formatter(timeZone) {
  let value = FORMATTERS.get(timeZone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      value.format(new Date(0));
    } catch (error) {
      throw new RuntimeInvariantError(`Invalid IANA time zone: ${timeZone}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    FORMATTERS.set(timeZone, value);
  }
  return value;
}

export function zonedParts(instant, timeZone) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(epochMs(instant)))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    minuteOfDay: parts.hour * 60 + parts.minute,
  };
}

export function parseClock(value, name = "clock") {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/u.test(value)) {
    throw new RuntimeInvariantError(`${name} must use HH:mm`);
  }
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) {
    throw new RuntimeInvariantError(`${name} is outside the 24-hour clock`);
  }
  return hour * 60 + minute;
}

export function isMinuteInQuietHours(minuteOfDay, quietHours) {
  if (!quietHours?.enabled) return false;
  const start = parseClock(quietHours.start, "quietHours.start");
  const end = parseClock(quietHours.end, "quietHours.end");
  if (start === end) return true;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

export function evaluateQuietHours(instant, quietHours, fallbackTimeZone = "UTC") {
  if (!quietHours?.enabled) {
    return { quiet: false, nextAllowedAt: null, timeZone: quietHours?.timeZone ?? fallbackTimeZone };
  }
  const timeZone = quietHours.timeZone || fallbackTimeZone;
  const currentMs = epochMs(instant);
  const quiet = isMinuteInQuietHours(zonedParts(currentMs, timeZone).minuteOfDay, quietHours);
  if (!quiet) return { quiet: false, nextAllowedAt: null, timeZone };

  // Walk actual instants instead of doing offset arithmetic. This is cheap for a
  // scheduler tick and remains correct across DST gaps and repeated hours.
  const rounded = currentMs - (currentMs % 60_000);
  for (let step = 1; step <= 72 * 60; step += 1) {
    const candidate = rounded + step * 60_000;
    const local = zonedParts(candidate, timeZone);
    if (!isMinuteInQuietHours(local.minuteOfDay, quietHours)) {
      return { quiet: true, nextAllowedAt: iso(candidate), timeZone };
    }
  }
  throw new RuntimeInvariantError("Could not resolve the end of quiet hours", { timeZone });
}
