import { describe, expect, it } from "vitest";
import { addReaction, isValidReactionToken, parseReactions, readReactions, removeReaction, serializeReactions } from "../src/reactions";
import { parseMessages, renumberMessageIds, setHeaderField } from "../src/util";
import { FENCE, block, note } from "./fixtures";

describe("parseReactions", () => {
	it("reads entries in order, a missing count meaning 1", () => {
		expect(parseReactions("👍 3, ❤️, 🎉 2")).toEqual([
			{ emoji: "👍", count: 3 },
			{ emoji: "❤️", count: 1 },
			{ emoji: "🎉", count: 2 }
		]);
	});

	it("returns an empty list for a missing or empty value", () => {
		expect(parseReactions(undefined)).toEqual([]);
		expect(parseReactions("")).toEqual([]);
		expect(parseReactions("  ")).toEqual([]);
	});

	it("keeps multi-codepoint emoji and custom tokens whole", () => {
		expect(parseReactions("👍🏽 2, 👨‍👩‍👧, 🇩🇪, :pepe:")).toEqual([
			{ emoji: "👍🏽", count: 2 },
			{ emoji: "👨‍👩‍👧", count: 1 },
			{ emoji: "🇩🇪", count: 1 },
			{ emoji: ":pepe:", count: 1 }
		]);
	});

	it("skips malformed entries", () => {
		expect(parseReactions("👍 0, , ❤️ x, 🎉 1 2, 🔥 -1, 😂 4")).toEqual([
			{ emoji: "😂", count: 4 }
		]);
	});

	it("merges a repeated token into its first position", () => {
		expect(parseReactions("👍, ❤️ 2, 👍 3")).toEqual([
			{ emoji: "👍", count: 4 },
			{ emoji: "❤️", count: 2 }
		]);
	});

	it("tolerates irregular spacing", () => {
		expect(parseReactions("👍   3 ,❤️")).toEqual([
			{ emoji: "👍", count: 3 },
			{ emoji: "❤️", count: 1 }
		]);
	});
});

describe("serializeReactions", () => {
	it("omits a count of 1", () => {
		expect(serializeReactions([
			{ emoji: "👍", count: 3 },
			{ emoji: "❤️", count: 1 }
		])).toBe("👍 3, ❤️");
	});

	it("round-trips its own output", () => {
		const value = "👍 3, ❤️, :pepe: 12";
		expect(serializeReactions(parseReactions(value))).toBe(value);
	});

	it("writes nothing for an empty list", () => {
		expect(serializeReactions([])).toBe("");
	});
});

describe("addReaction / removeReaction", () => {
	it("appends a new reaction", () => {
		expect(addReaction([{ emoji: "👍", count: 1 }], "❤️")).toEqual([
			{ emoji: "👍", count: 1 },
			{ emoji: "❤️", count: 1 }
		]);
	});

	it("counts up an existing reaction in place", () => {
		expect(addReaction([{ emoji: "👍", count: 1 }, { emoji: "❤️", count: 1 }], "👍")).toEqual([
			{ emoji: "👍", count: 2 },
			{ emoji: "❤️", count: 1 }
		]);
	});

	it("counts down by one and drops the reaction at zero", () => {
		const list = [{ emoji: "👍", count: 2 }, { emoji: "❤️", count: 1 }];

		expect(removeReaction(list, "👍")).toEqual([
			{ emoji: "👍", count: 1 },
			{ emoji: "❤️", count: 1 }
		]);
		expect(removeReaction(list, "❤️")).toEqual([{ emoji: "👍", count: 2 }]);
	});

	it("leaves the list unchanged for a reaction it doesn't have", () => {
		expect(removeReaction([{ emoji: "👍", count: 1 }], "❤️")).toEqual([{ emoji: "👍", count: 1 }]);
	});

	it("does not mutate its input", () => {
		const list = [{ emoji: "👍", count: 1 }];
		addReaction(list, "👍");
		removeReaction(list, "👍");
		expect(list).toEqual([{ emoji: "👍", count: 1 }]);
	});
});

describe("isValidReactionToken", () => {
	it("rejects empty values, whitespace and commas", () => {
		expect(isValidReactionToken("👍")).toBe(true);
		expect(isValidReactionToken(":pepe:")).toBe(true);
		expect(isValidReactionToken("")).toBe(false);
		expect(isValidReactionToken("a b")).toBe(false);
		expect(isValidReactionToken("a,b")).toBe(false);
		expect(isValidReactionToken("x".repeat(65))).toBe(false);
	});
});

describe("setHeaderField", () => {
	const lines = [
		FENCE + "chat-message",
		"id: 1",
		"author: Alice",
		"timestamp: 06.08.2026 14:33",
		"~~~",
		"",
		"reactions: not a header line",
		"",
		FENCE
	];

	it("inserts a missing key just above the separator", () => {
		expect(setHeaderField(lines, "reactions", "👍 2")).toEqual([
			FENCE + "chat-message",
			"id: 1",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"reactions: 👍 2",
			"~~~",
			"",
			"reactions: not a header line",
			"",
			FENCE
		]);
	});

	it("rewrites an existing key where it is", () => {
		const withKey = [FENCE + "chat-message", "id: 1", "reactions: 👍", "author: Alice", "~~~", "", FENCE];

		expect(setHeaderField(withKey, "reactions", "👍 2")).toEqual(
			[FENCE + "chat-message", "id: 1", "reactions: 👍 2", "author: Alice", "~~~", "", FENCE]
		);
	});

	it("matches keys the way Header.fromLines reads them", () => {
		const loose = [FENCE + "chat-message", "id: 1", "  reactions :👍", "~~~", "", FENCE];

		expect(setHeaderField(loose, "reactions", "❤️")).toEqual(
			[FENCE + "chat-message", "id: 1", "reactions: ❤️", "~~~", "", FENCE]
		);
	});

	it("removes the key for null, and only from the header", () => {
		const withKey = setHeaderField(lines, "reactions", "👍");
		expect(setHeaderField(withKey, "reactions", null)).toEqual(lines);
	});

	it("collapses a duplicated key into one line", () => {
		const duplicated = [FENCE + "chat-message", "id: 1", "pinned: true", "author: Alice", "pinned: false", "~~~", "", FENCE];

		expect(setHeaderField(duplicated, "pinned", "true")).toEqual(
			[FENCE + "chat-message", "id: 1", "pinned: true", "author: Alice", "~~~", "", FENCE]
		);
	});

	it("returns a block without a separator unchanged", () => {
		const broken = [FENCE + "chat-message", "id: 1", FENCE];
		expect(setHeaderField(broken, "reactions", "👍")).toBe(broken);
	});
});

describe("reactions in a message block", () => {
	const source = block([
		"id: 4",
		"author: Alice",
		"timestamp: 06.08.2026 14:33",
		"reactions: 👍 3, ❤️",
		"~~~",
		"",
		"Hello",
		""
	]) + "\n";

	it("are read off the parsed header", () => {
		const message = parseMessages(source)[0].get("4")?.message;
		expect(message && readReactions(message.header)).toEqual([
			{ emoji: "👍", count: 3 },
			{ emoji: "❤️", count: 1 }
		]);
	});

	it("survive a Message round trip byte for byte", () => {
		expect(parseMessages(source)[0].get("4")?.message.toString()).toBe(source);
	});

	it("are left untouched by the renumber", () => {
		const result = renumberMessageIds(note(source.trimEnd()));
		expect(result?.lines.join("\n")).toBe(note(source.trimEnd().replace("id: 4", "id: 1")));
	});
});
