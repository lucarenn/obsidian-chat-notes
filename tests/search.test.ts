import { describe, expect, it } from "vitest";
import { hiddenLineRanges, isFilteredOut, messageMatches, parseSearchQuery, SearchQuery } from "../src/search";
import { Header, Message } from "../src/types";
import { block, note, FIRST_BLOCK_LINE } from "./fixtures";

function message(body: string, extra: Record<string, string> = {}): Message {
	return Message.create(new Header("1", "Alice", "06.08.2026 14:33", extra), body);
}

function query(raw: string): SearchQuery {
	const parsed = parseSearchQuery(raw);
	if (!parsed) throw new Error(`"${raw}" parsed as no query`);
	return parsed;
}

describe("parseSearchQuery", () => {
	it("returns null for a blank query", () => {
		expect(parseSearchQuery("")).toBeNull();
		expect(parseSearchQuery("   ")).toBeNull();
	});

	it("trims and lower-cases the text", () => {
		expect(parseSearchQuery("  Deploy Done ")).toEqual({ text: "deploy done" });
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
