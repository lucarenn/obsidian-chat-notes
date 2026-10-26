import { describe, expect, it } from "vitest";
import { collectSuggestionValues, hiddenLineRanges, isFilteredOut, messageMatches, parseSearchQuery, searchSuggestions, SearchQuery } from "../src/search";
import { parseDateValue, parseMessageTime } from "../src/search-dates";
import { EMOJI_CATEGORIES, QUICK_REACTIONS, emojiByName, emojiName } from "../src/emoji-data";
import { Header, Message } from "../src/types";
import { block, note, FIRST_BLOCK_LINE } from "./fixtures";

function message(body: string, extra: Record<string, string> = {}, author = "Alice", timestamp = "06.08.2026 14:33"): Message {
	return Message.create(new Header("1", author, timestamp, extra), body);
}

// a fixed "now" for the relative dates: 10.08.2026 12:00, local time
const NOW = new Date(2026, 7, 10, 12, 0);

function query(raw: string): SearchQuery {
	const parsed = parseSearchQuery(raw, NOW);
	if (!parsed) throw new Error(`"${raw}" parsed as no query`);
	return parsed;
}

describe("parseSearchQuery", () => {
	it("returns null for a blank query", () => {
		expect(parseSearchQuery("")).toBeNull();
		expect(parseSearchQuery("   ")).toBeNull();
	});

	it("trims and lower-cases the text", () => {
		expect(query("  Deploy Done ").text).toBe("deploy done");
	});

	it("takes filters out of the text and keeps the rest as one phrase", () => {
		const q = query("deploy author:Bob done");
		expect(q.text).toBe("deploy done");
		expect(q.authors).toEqual(["bob"]);
	});

	it("reads quoted values, closed or still being typed", () => {
		expect(query('author:"Alice Smith" hi').authors).toEqual(["alice smith"]);
		expect(query('author:"Alice Sm').authors).toEqual(["alice sm"]);
	});

	it("accepts the aliases, in any case", () => {
		const q = query("FROM:bob contains:x older:2025 newer:2020");
		expect(q.authors).toEqual(["bob"]);
		expect(q.content).toEqual(["x"]);
		expect(q.before).toBe(new Date(2025, 0, 1).getTime());
		expect(q.after).toBe(new Date(2021, 0, 1).getTime());
	});

	it("leaves words that are not filters as text", () => {
		expect(query("https://example.com").text).toBe("https://example.com");
		expect(query("at 14:33").text).toBe("at 14:33");
		expect(query("xauthor:bob").authors).toEqual([]);
	});

	it("is null for filters with no value yet", () => {
		expect(parseSearchQuery("author:", NOW)).toBeNull();
		expect(parseSearchQuery('author:"" ', NOW)).toBeNull();
	});

	it("collects date values that don't parse, instead of filtering by them", () => {
		const q = query("before:soon");
		expect(q.invalid).toEqual(["before:soon"]);
		expect(q.before).toBeUndefined();
	});

	it("keeps the strictest of repeated date filters", () => {
		const q = query("before:2026 before:2025 after:2020 after:2022");
		expect(q.before).toBe(new Date(2025, 0, 1).getTime());
		expect(q.after).toBe(new Date(2023, 0, 1).getTime());
	});
});

describe("parseDateValue", () => {
	const range = (start: Date, end: Date) => ({ start: start.getTime(), end: end.getTime() });
	const instant = (date: Date) => range(date, date);

	it("covers a whole day, month or year", () => {
		expect(parseDateValue("6.8.2026", NOW)).toEqual(range(new Date(2026, 7, 6), new Date(2026, 7, 7)));
		expect(parseDateValue("08.2026", NOW)).toEqual(range(new Date(2026, 7, 1), new Date(2026, 8, 1)));
		expect(parseDateValue("2026", NOW)).toEqual(range(new Date(2026, 0, 1), new Date(2027, 0, 1)));
	});

	it("covers one minute when given a time", () => {
		expect(parseDateValue("06.08.2026 14:33", NOW))
			.toEqual(range(new Date(2026, 7, 6, 14, 33), new Date(2026, 7, 6, 14, 34)));
	});

	it("accepts ISO dates", () => {
		expect(parseDateValue("2026-08-06", NOW)).toEqual(parseDateValue("06.08.2026", NOW));
		expect(parseDateValue("2026-08", NOW)).toEqual(parseDateValue("08.2026", NOW));
	});

	it("reads today, yesterday and relative values against now", () => {
		expect(parseDateValue("today", NOW)).toEqual(range(new Date(2026, 7, 10), new Date(2026, 7, 11)));
		expect(parseDateValue("Yesterday", NOW)).toEqual(range(new Date(2026, 7, 9), new Date(2026, 7, 10)));

		expect(parseDateValue("7d", NOW)).toEqual(instant(new Date(2026, 7, 3, 12, 0)));
		expect(parseDateValue("2w", NOW)).toEqual(instant(new Date(2026, 6, 27, 12, 0)));
		expect(parseDateValue("1m", NOW)).toEqual(instant(new Date(2026, 6, 10, 12, 0)));
		expect(parseDateValue("1y", NOW)).toEqual(instant(new Date(2025, 7, 10, 12, 0)));
	});

	it("rejects dates that don't exist and other text", () => {
		expect(parseDateValue("31.02.2026", NOW)).toBeNull();
		expect(parseDateValue("13.2026", NOW)).toBeNull();
		expect(parseDateValue("06.08.2026 25:00", NOW)).toBeNull();
		expect(parseDateValue("soon", NOW)).toBeNull();
	});
});

describe("parseMessageTime", () => {
	it("reads the message timestamp format, with or without a time", () => {
		expect(parseMessageTime("06.08.2026 14:33")).toBe(new Date(2026, 7, 6, 14, 33).getTime());
		expect(parseMessageTime("6.8.2026")).toBe(new Date(2026, 7, 6).getTime());
		expect(parseMessageTime("yesterday")).toBeNull();
	});
});

describe("messageMatches", () => {
	it("matches a substring of the body, ignoring case", () => {
		expect(messageMatches(message("The deploy is DONE"), query("is done"))).toBe(true);
		expect(messageMatches(message("The deploy is done"), query("rollback"))).toBe(false);
	});

	it("matches the raw markdown of the body", () => {
		expect(messageMatches(message("see **this**"), query("**this**"))).toBe(true);
	});

	it("matches the author and the timestamp", () => {
		expect(messageMatches(message("hi"), query("alice"))).toBe(true);
		expect(messageMatches(message("hi"), query("14:33"))).toBe(true);
	});

	it("matches a reaction emoji", () => {
		const reacted = message("hi", { reactions: "👍 3, 🎉" });
		expect(messageMatches(reacted, query("🎉"))).toBe(true);
		expect(messageMatches(reacted, query("❤️"))).toBe(false);
	});

	it("does not match across two fields", () => {
		// author "Alice" followed by body "Bob" must not match "alice bob"
		expect(messageMatches(message("Bob"), query("alice bob"))).toBe(false);
	});

	it("does not match other header keys", () => {
		expect(messageMatches(message("hi", { pinned: "true" }), query("true"))).toBe(false);
	});
});

describe("messageMatches with filters", () => {
	it("author: matches part of the author, and repeated means either", () => {
		expect(messageMatches(message("hi"), query("author:ali"))).toBe(true);
		expect(messageMatches(message("hi"), query("author:bob"))).toBe(false);
		expect(messageMatches(message("hi"), query("author:bob author:alice"))).toBe(true);
	});

	it("content: looks at the body only, and repeated means both", () => {
		expect(messageMatches(message("hi"), query("content:alice"))).toBe(false);
		expect(messageMatches(message("deploy done"), query("content:deploy content:done"))).toBe(true);
		expect(messageMatches(message("deploy"), query("content:deploy content:done"))).toBe(false);
	});

	it("reaction: ignores the variation selector and needs every one", () => {
		const reacted = message("hi", { reactions: "❤️ 2, :fire:" });
		expect(messageMatches(reacted, query("reaction:❤"))).toBe(true);
		expect(messageMatches(reacted, query("reaction:fire"))).toBe(true);
		expect(messageMatches(reacted, query("reaction:fire reaction:👍"))).toBe(false);
	});

	it("reaction: finds an emoji by its name, and a stored name by its emoji", () => {
		const picked = message("hi", { reactions: "🔥" });
		expect(messageMatches(picked, query("reaction:fire"))).toBe(true);
		expect(messageMatches(picked, query("reaction::fire:"))).toBe(true);
		expect(messageMatches(picked, query("reaction:FIRE"))).toBe(true);

		const imported = message("hi", { reactions: ":fire:" });
		expect(messageMatches(imported, query("reaction:🔥"))).toBe(true);
	});

	it("reaction: with an exact name means that emoji, a partial one any name containing it", () => {
		const reacted = message("hi", { reactions: ":firefox:" });
		expect(messageMatches(reacted, query("reaction:fire"))).toBe(false);
		expect(messageMatches(reacted, query("reaction:fir"))).toBe(true);
		expect(messageMatches(message("hi", { reactions: "🔥" }), query("reaction:fir"))).toBe(true);
		expect(messageMatches(message("hi", { reactions: "😍" }), query("reaction:heart"))).toBe(false);
	});

	it("reaction: finds custom tokens and emoji the picker doesn't list", () => {
		expect(messageMatches(message("hi", { reactions: ":partyparrot:" }), query("reaction:parrot"))).toBe(true);
		expect(messageMatches(message("hi", { reactions: "🦊" }), query("reaction:🦊"))).toBe(true);
	});

	it("before: and after: exclude the period they name", () => {
		const msg = message("hi"); // 06.08.2026 14:33
		expect(messageMatches(msg, query("before:07.08.2026"))).toBe(true);
		expect(messageMatches(msg, query("before:06.08.2026"))).toBe(false);
		expect(messageMatches(msg, query("after:05.08.2026"))).toBe(true);
		expect(messageMatches(msg, query("after:06.08.2026"))).toBe(false);
		expect(messageMatches(msg, query('after:"06.08.2026 14:32"'))).toBe(true);
	});

	it("after: with a relative value means since then", () => {
		// the message is 4 days before NOW
		expect(messageMatches(message("hi"), query("after:7d"))).toBe(true);
		expect(messageMatches(message("hi"), query("after:3d"))).toBe(false);
		expect(messageMatches(message("hi"), query("older:3d"))).toBe(true);
	});

	it("time: matches a period, or the timestamp's text when it isn't a date", () => {
		expect(messageMatches(message("hi"), query("time:6.8.2026"))).toBe(true);
		expect(messageMatches(message("hi"), query("time:08.2026"))).toBe(true);
		expect(messageMatches(message("hi"), query("time:2025"))).toBe(false);
		expect(messageMatches(message("hi"), query("time:14:3"))).toBe(true);
		expect(messageMatches(message("hi"), query("time:7d"))).toBe(true);
	});

	it("leaves a message whose timestamp can't be read out of date filters only", () => {
		const odd = message("hi", {}, "Alice", "some time");
		expect(messageMatches(odd, query("after:2020"))).toBe(false);
		expect(messageMatches(odd, query("author:alice"))).toBe(true);
	});

	it("combines filters and text with AND", () => {
		const msg = message("deploy done");
		expect(messageMatches(msg, query("author:alice after:2026 deploy"))).toBe(false);
		expect(messageMatches(msg, query("author:alice after:2025 deploy"))).toBe(true);
		expect(messageMatches(msg, query("author:alice after:2025 rollback"))).toBe(false);
		expect(messageMatches(msg, query("author:bob deploy"))).toBe(false);
	});

	it("matches everything when every filter was ignored", () => {
		expect(messageMatches(message("hi"), query("before:soon"))).toBe(true);
	});
});

describe("searchSuggestions", () => {
	const values = { authors: ["Alice", "Bob Stone"], reactions: ["👍", ":fire:"] };
	const at = (input: string) => searchSuggestions(input, input.length, values);
	const labels = (input: string) => at(input).map(s => s.label);

	it("offers every filter in a blank field, and none after a finished word", () => {
		expect(labels("")).toEqual(["author:", "content:", "time:", "reaction:", "before:", "after:"]);
		expect(labels("deploy ")).toEqual([]);
	});

	it("completes a filter name, by the alias being typed", () => {
		expect(labels("deploy a")).toEqual(["author:", "after:"]);
		expect(labels("old")).toEqual(["older:"]);
		expect(labels("con")).toEqual(["content:"]);
		expect(labels("xyz")).toEqual([]);
	});

	it("offers the note's authors and reactions as values", () => {
		expect(labels("author:")).toEqual(["Alice", "Bob Stone"]);
		expect(labels("from:st")).toEqual(["Bob Stone"]);
		expect(labels("reaction:fi")).toEqual([":fire:"]);
		expect(labels("content:")).toEqual([]);
	});

	it("finds reaction values by name, with the name as the hint", () => {
		const withEmoji = { authors: [], reactions: ["🔥", "👍"] };
		const [fire] = searchSuggestions("reaction:fi", 11, withEmoji);
		expect(fire).toMatchObject({ label: "🔥", hint: ":fire:", insert: "reaction:🔥 " });
		expect(searchSuggestions("reaction:thumbs", 15, withEmoji).map(s => s.label)).toEqual(["👍"]);
	});

	it("offers dates for the date filters", () => {
		expect(labels("before:")).toEqual(["today", "yesterday", "7d", "30d", "1y"]);
		expect(at("after:7")[0]?.hint).toBe("In the last 7 days");
	});

	it("replaces the word at the caret, quoting a value with a space", () => {
		const [pick] = at("hi from:bo");
		expect(pick).toMatchObject({ from: 3, to: 10, insert: 'from:"Bob Stone" ' });

		const [name] = searchSuggestions("aut hi", 2, values);
		expect(name).toMatchObject({ from: 0, to: 3, insert: "author:" });
	});
});

describe("emoji names", () => {
	it("give every listed emoji one name, unique, and back", () => {
		const pairs = EMOJI_CATEGORIES.flatMap(category => category.emoji);
		expect(new Set(pairs.map(([, name]) => name)).size).toBe(pairs.length);
		for (const [emoji, name] of pairs) {
			expect(emojiName(emoji)).toBe(name);
			expect(emojiByName(`:${name}:`)).toBe(emoji);
		}
		for (const emoji of QUICK_REACTIONS) expect(emojiName(emoji)).toBeDefined();
	});
});

describe("collectSuggestionValues", () => {
	it("collects authors in file order and reactions most used first", () => {
		const values = collectSuggestionValues([
			message("a", { reactions: "👍, 🎉 2" }, "Bob"),
			message("b", { reactions: "👍 3" }, "Alice"),
			message("c", {}, "Bob")
		]);
		expect(values).toEqual({ authors: ["Bob", "Alice"], reactions: ["👍", "🎉"] });
	});
});

describe("isFilteredOut", () => {
	it("hides unpinned messages when showing pinned only", () => {
		const filter = { pinnedOnly: true };
		expect(isFilteredOut(message("hi"), filter)).toBe(true);
		expect(isFilteredOut(message("hi", { pinned: "true" }), filter)).toBe(false);
	});

	it("requires a message to pass both filters", () => {
		const filter = { pinnedOnly: true, query: query("deploy") };
		expect(isFilteredOut(message("deploy", { pinned: "true" }), filter)).toBe(false);
		expect(isFilteredOut(message("deploy"), filter)).toBe(true);
		expect(isFilteredOut(message("other", { pinned: "true" }), filter)).toBe(true);
	});
});

describe("hiddenLineRanges", () => {
	// 9 lines: fence, three header lines, separator, blank, body, blank, fence
	function msgBlock(id: string, body: string): string {
		return block([`id: ${id}`, "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", body, ""]);
	}
	const BLOCK_LINES = 9;

	it("merges hidden blocks separated only by blank lines, and keeps matches out", () => {
		const text = note(
			msgBlock("1", "match"), "",
			msgBlock("2", "no"), "",
			msgBlock("3", "no"), "",
			msgBlock("4", "match")
		);
		const start2 = FIRST_BLOCK_LINE + BLOCK_LINES + 1;
		const end3 = start2 + BLOCK_LINES + 1 + BLOCK_LINES - 1;

		expect(hiddenLineRanges(text, { pinnedOnly: false, query: query("match") }))
			.toEqual([[start2, end3]]);
	});

	it("does not merge across a visible message", () => {
		const text = note(msgBlock("1", "no"), msgBlock("2", "match"), msgBlock("3", "no"));
		const ranges = hiddenLineRanges(text, { pinnedOnly: false, query: query("match") });

		expect(ranges).toEqual([
			[FIRST_BLOCK_LINE, FIRST_BLOCK_LINE + BLOCK_LINES - 1],
			[FIRST_BLOCK_LINE + 2 * BLOCK_LINES, FIRST_BLOCK_LINE + 3 * BLOCK_LINES - 1]
		]);
	});

	it("hides nothing when everything matches", () => {
		const text = note(msgBlock("1", "match"), msgBlock("2", "match"));
		expect(hiddenLineRanges(text, { pinnedOnly: false, query: query("match") })).toEqual([]);
	});
});
