import { describe, expect, it } from "vitest";
import { findMessageBlocks, renumberMessageIds } from "../src/util";
import { FIRST_BLOCK_LINE, block, note } from "./fixtures";

/* recalculateMessageIds is the one command that rewrites a whole user file at once, and it
   runs on files that are already broken - so these cover what it does to the text, not what
   it does to the vault. The Obsidian half (which editor to read, where to write) is the part
   that is left in main.ts. */

function renumber(source: string) {
	const result = renumberMessageIds(source);
	if (!result) throw new Error("expected the renumber to find blocks");

	return { ...result, text: result.lines.join("\n") };
}

function idsOf(text: string): string[] {
	return findMessageBlocks(text).map(b => b.id);
}

function replyTargetsOf(text: string): string[] {
	return text.split("\n")
		.filter(line => line.trimStart().startsWith("reply_to:"))
		.map(line => line.trimStart().slice("reply_to:".length).trim());
}

function message(id: string, extra: string[] = [], body = "hi"): string {
	return block([
		`id: ${id}`,
		"author: Alice",
		"timestamp: 06.08.2026 14:33",
		...extra,
		"~~~",
		"",
		body,
		""
	]);
}

describe("renumberMessageIds", () => {
	it("numbers every block by its position in the file", () => {
		const source = note(message("40"), message("7"), message("999"));

		expect(idsOf(renumber(source).text)).toEqual(["1", "2", "3"]);
	});

	it("reports how many blocks it renumbered", () => {
		const source = note(message("40"), message("7"));

		expect(renumber(source).blockCount).toBe(2);
	});

	it("returns undefined for a note with no message blocks", () => {
		expect(renumberMessageIds(note())).toBeUndefined();
		expect(renumberMessageIds("just some prose")).toBeUndefined();
	});

	it("rewrites reply_to to the target's new number", () => {
		const source = note(
			message("40"),
			message("7", ["reply_to: 40"])
		);

		const result = renumber(source);

		expect(idsOf(result.text)).toEqual(["1", "2"]);
		expect(replyTargetsOf(result.text)).toEqual(["1"]);
		expect(result.droppedReplies).toBe(0);
	});

	/* A reply whose target is gone cannot keep its number: the ids below are now 1..N, so the
	   old one would name an unrelated message. Dropping the line is the only safe answer. */
	it("drops a reply_to with no surviving target, and counts it", () => {
		const source = note(
			message("40"),
			message("7", ["reply_to: 123"])
		);

		const result = renumber(source);

		expect(replyTargetsOf(result.text)).toEqual([]);
		expect(result.droppedReplies).toBe(1);
		expect(result.text).not.toContain("reply_to:");
	});

	it("keeps the other header keys of a block whose reply_to it drops", () => {
		const source = note(
			message("40"),
			message("7", ["pinned: true", "reply_to: 123"])
		);

		expect(renumber(source).text).toContain("pinned: true");
	});

	/* Duplicated ids are the commonest hand-edit break and the reason the renumber walks
	   blocks rather than the message map. Each block still takes its own position as its new
	   id, while a reply to the duplicated id resolves to the earlier of the two. */
	it("gives duplicated ids distinct numbers and resolves replies to the first", () => {
		const source = note(
			message("1"),
			message("1"),
			message("9", ["reply_to: 1"])
		);

		const result = renumber(source);

		expect(idsOf(result.text)).toEqual(["1", "2", "3"]);
		expect(replyTargetsOf(result.text)).toEqual(["1"]);
		expect(result.droppedReplies).toBe(0);
	});

	it("maps old ids to new ones for the pending reply target", () => {
		const source = note(message("40"), message("7"), message("999"));

		expect([...renumber(source).newIds]).toEqual([
			["40", "1"],
			["7", "2"],
			["999", "3"]
		]);
	});

	/* The write replaces from firstBlockLine to the end of the document, so everything above
	   it - the frontmatter carrying type, author and every per-note override - is never part
	   of the rewrite. */
	it("leaves the frontmatter untouched and reports where the blocks start", () => {
		const source = note(message("40"));
		const result = renumber(source);

		expect(result.firstBlockLine).toBe(FIRST_BLOCK_LINE);
		expect(result.lines.slice(0, FIRST_BLOCK_LINE)).toEqual([
			"---",
			"type: chat-note",
			"author: Alice",
			"---",
			""
		]);
	});

	// header only: a body line that looks like a header key is content, not metadata
	it("does not rewrite an id-shaped line in the body", () => {
		const source = note(message("40", [], "id: 99"));
		const result = renumber(source);

		expect(idsOf(result.text)).toEqual(["1"]);
		expect(result.text).toContain("id: 99");
	});

	it("does not rewrite a reply_to-shaped line in the body", () => {
		const source = note(message("40", [], "reply_to: 123"));
		const result = renumber(source);

		expect(result.text).toContain("reply_to: 123");
		expect(result.droppedReplies).toBe(0);
	});

	/* The rewrite has to accept exactly what findMessageBlocks accepted. If one took an
	   indented key and the other did not, that block would keep its old id and collide with
	   the new numbering - a duplicate created by the command meant to remove them. */
	it("renumbers an indented id key, matching what findMessageBlocks finds", () => {
		const source = note(
			block(["  id: 40", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "hi", ""]),
			message("7")
		);

		expect(idsOf(renumber(source).text)).toEqual(["1", "2"]);
	});

	it("preserves the message bodies verbatim", () => {
		const source = note(
			message("40", [], "First line"),
			message("7", [], "Second line")
		);

		const text = renumber(source).text;

		expect(text).toContain("First line");
		expect(text).toContain("Second line");
	});

	// running the repair twice must be a no-op, not a second renumbering
	it("is idempotent on an already correct file", () => {
		const source = note(message("40"), message("7", ["reply_to: 40"]));

		const once = renumber(source).text;
		const twice = renumber(once).text;

		expect(twice).toBe(once);
	});
});
