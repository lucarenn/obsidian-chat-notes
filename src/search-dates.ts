/* The dates a search filter accepts (before:, after:, time:), and reading a message's own
   timestamp. Pure; `now` is passed in so the relative forms can be tested. */

// a span of time in ms since the epoch, `end` exclusive
export interface TimeRange {
	start: number;
	end: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// the date, or null when the fields don't name a real one (31.02., month 13)
function localDate(year: number, month: number, day = 1, hours = 0, minutes = 0): Date | null {
	const date = new Date(year, month - 1, day, hours, minutes);
	const valid = date.getFullYear() === year && date.getMonth() === month - 1
		&& date.getDate() === day && date.getHours() === hours && date.getMinutes() === minutes;
	return valid ? date : null;
}

// the numeric capture groups of a match, 0 for one that didn't take part
function fields(match: RegExpExecArray): [number, number, number, number, number] {
	const at = (i: number) => Number(match[i] ?? 0);
	return [at(1), at(2), at(3), at(4), at(5)];
}

// DD.MM.YYYY with an optional HH:MM, the format messages are stamped in (leading zeros optional)
const DAY_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/;

/* What a date value covers: a whole year, month, day or minute, so before: and after: can be
   exclusive of it the way Discord's are - "after:06.08.2026" starts on the 7th. A relative
   value ("7d") is a single instant, start === end. */
export function parseDateValue(raw: string, now: Date): TimeRange | null {
	const value = raw.trim().toLowerCase();

	if (value === "today" || value === "yesterday") {
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		if (value === "yesterday") start.setDate(start.getDate() - 1);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		return { start: start.getTime(), end: end.getTime() };
	}

	// h, d, w, m (months), y back from now
	const relative = /^(\d+)\s*([hdwmy])$/.exec(value);
	if (relative) {
		const amount = Number(relative[1]);
		const at = new Date(now);
		switch (relative[2]) {
			case "h": at.setTime(at.getTime() - amount * 60 * 60 * 1000); break;
			case "d": at.setTime(at.getTime() - amount * DAY_MS); break;
			case "w": at.setTime(at.getTime() - amount * 7 * DAY_MS); break;
			case "m": at.setMonth(at.getMonth() - amount); break;
			case "y": at.setFullYear(at.getFullYear() - amount); break;
		}
		return { start: at.getTime(), end: at.getTime() };
	}

	const day = DAY_PATTERN.exec(value);
	if (day) {
		const [d, m, y, hh, mm] = fields(day);
		if (day[4] !== undefined) {
			const start = localDate(y, m, d, hh, mm);
			return start ? { start: start.getTime(), end: start.getTime() + 60 * 1000 } : null;
		}
		const start = localDate(y, m, d);
		return start ? { start: start.getTime(), end: new Date(y, m - 1, d + 1).getTime() } : null;
	}

	// MM.YYYY, or YYYY-MM-DD / YYYY-MM for anyone who types ISO dates
	const month = /^(\d{1,2})\.(\d{4})$/.exec(value);
	const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
	if (month || iso) {
		const y = Number(month ? month[2] : iso?.[1]);
		const m = Number(month ? month[1] : iso?.[2]);
		const d = iso?.[3] !== undefined ? Number(iso[3]) : undefined;

		const start = localDate(y, m, d ?? 1);
		if (!start) return null;
		const end = d !== undefined ? new Date(y, m - 1, d + 1) : new Date(y, m, 1);
		return { start: start.getTime(), end: end.getTime() };
	}

	const year = /^(\d{4})$/.exec(value);
	if (year) {
		const y = Number(year[1]);
		return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime() };
	}

	return null;
}

// a message's timestamp in ms, or null when it isn't in the DD.MM.YYYY [HH:MM] format
export function parseMessageTime(timestamp: string): number | null {
	const match = DAY_PATTERN.exec(timestamp.trim());
	if (!match) return null;
	const [d, m, y, hh, mm] = fields(match);
	const date = match[4] !== undefined ? localDate(y, m, d, hh, mm) : localDate(y, m, d);
	return date ? date.getTime() : null;
}
