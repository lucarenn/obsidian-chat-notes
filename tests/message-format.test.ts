import { describe, expect, it } from "vitest";
import { Header, Message } from "../src/types";
import { extractMessageIdFromSource, findMessageBlocks, parseMessages } from "../src/util";
import { block, note } from "./fixtures";

describe("Message round trip", () => {
	/* The property every write depends on: parse a block, serialise it back, and get the
	   same bytes. withMessageBlock rewrites blocks in place, so any drift here is a diff
	   the user never asked for - and, applied repeatedly, a file that changes on every edit. */
	it("re-serialises a canonical block byte for byte", () => {
		const source = block([
			"id: 7",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"~~~",
			"",
			"Hello there",
			""
		]) + "\n";

		const [messages] = parseMessages(source);

		expect(messages.get("7")?.message.toString()).toBe(source);
	});

	it("is idempotent - a second round trip changes nothing", () => {
		const source = block([
			"id: 7",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"~~~",
			"",
			"Hello there",
			""
		]) + "\n";

		const once = parseMessages(source)[0].get("7")?.message.toString() ?? "";
		const twice = parseMessages(once)[0].get("7")?.message.toString() ?? "";

		expect(twice).toBe(once);
	});

	/* Blank lines are content: they carry the body's markdown paragraph structure. The
	   processor prefers the parsed body over the block's own source and the inline editor is
	   seeded from it, so collapsing them here writes the collapsed version back to disk. */
	it("keeps the blank line between two paragraphs", () => {
		const source = block([
			"id: 1",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"~~~",
			"",
			"First paragraph",
			"",
			"Second paragraph",
			""
		]) + "\n";

		const body = parseMessages(source)[0].get("1")?.message.content;

		expect(body).toBe("\nFirst paragraph\n\nSecond paragraph\n");
		expect(parseMessages(source)[0].get("1")?.message.toString()).toBe(source);
	});

	it("keeps consecutive blank lines inside a body", () => {
		const source = block([
			"id: 1",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"~~~",
			"",
			"Above",
			"",
			"",
			"Below",
			""
		]) + "\n";

		expect(parseMessages(source)[0].get("1")?.message.content)
			.toBe("\nAbove\n\n\nBelow\n");
	});

	it("normalises a body to open and close with a blank line", () => {
		const created = Message.create(new Header("1", "Alice", "06.08.2026 14:33"), "Hello");

		expect(created.content).toBe("\nHello\n");
	});

	// the whole reason the fence is four backticks
	it("carries a three-backtick code block through unharmed", () => {
		const source = block([
			"id: 2",
			"author: Bob",
			"timestamp: 06.08.2026 14:35",
			"~~~",
			"",
			"```js",
			"const a = 1;",
			"```",
			""
		]) + "\n";

		const message = parseMessages(source)[0].get("2");

		expect(message?.message.content).toContain("```js");
		expect(message?.message.toString()).toBe(source);
	});

	/* fromString splits on the FIRST "~~~", so a separator in the body is body text. Splitting
	   on the last one would silently move everything above it into the header and drop it. */
	it("does not treat a '~~~' in the body as the header separator", () => {
		const source = block([
			"id: 3",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"~~~",
			"",
			"before",
			"~~~",
			"after",
			""
		]) + "\n";

		const message = parseMessages(source)[0].get("3")?.message;

		expect(message?.header.author).toBe("Alice");
		expect(message?.content).toBe("\nbefore\n~~~\nafter\n");
	});
});

describe("Header parsing", () => {
	// Header.fromLines accepts any order; toString normalises it. A hand-edited or imported
	// block routinely leads with something other than id.
	it("accepts header keys in any order", () => {
		const header = Header.fromLines([
			"reply_to: 4",
			"timestamp: 06.08.2026 14:33",
			"id: 9",
			"author: Alice"
		]);

		expect(header.id).toBe("9");
		expect(header.author).toBe("Alice");
		expect(header.timestamp).toBe("06.08.2026 14:33");
		expect(header.extra).toEqual({ reply_to: "4" });
	});

	it("emits the three known keys first and the extras after, whatever the input order", () => {
		const header = Header.fromLines([
			"pinned: true",
			"id: 9",
			"reply_to: 4",
			"author: Alice",
			"timestamp: 06.08.2026 14:33"
		]);

		expect(header.toString().split("\n")).toEqual([
			"id: 9",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"pinned: true",
			"reply_to: 4",
			"~~~"
		]);
	});

	/* Unknown keys round-trip untouched - the mechanism pinned and reply_to were both added
	   through, and the reason the format has needed no version field. */
	it("preserves a key it knows nothing about", () => {
		const header = Header.fromLines([
			"id: 1",
			"author: Alice",
			"timestamp: 06.08.2026 14:33",
			"some_future_key: some value"
		]);

		expect(header.extra.some_future_key).toBe("some value");
		expect(header.toString()).toContain("some_future_key: some value");
	});

	// the timestamp's own colon must survive - fromLines splits on the first colon only
	it("keeps a value containing colons", () => {
		const header = Header.fromLines(["id: 1", "timestamp: 06.08.2026 14:33"]);

		expect(header.timestamp).toBe("06.08.2026 14:33");
	});

	it("defaults a missing author and timestamp to empty rather than throwing", () => {
		const header = Header.fromLines(["id: 1"]);

		expect(header.author).toBe("");
		expect(header.timestamp).toBe("");
	});

	it("throws on a header with no id", () => {
		expect(() => Header.fromLines(["author: Alice"])).toThrow();
	});

	it("throws on a block with no '~~~' separator", () => {
		expect(() => Message.fromString("id: 1\nauthor: Alice")).toThrow();
	});

	/* extractMessageIdFromSource reads the first line only - correct for blocks this plugin
	   wrote, and the reason findMessageBlocks has to search the whole header instead. */
	it("reads the id off the first line, and rejects a header that does not lead with it", () => {
		expect(extractMessageIdFromSource("id: 12\nauthor: Alice")).toBe("12");
		expect(() => extractMessageIdFromSource("author: Alice\nid: 12")).toThrow();
	});
});

describe("parseMessages", () => {
	it("reports duplicate ids and keeps only one entry for them", () => {
		const source = note(
			block(["id: 1", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "one", ""]),
			block(["id: 1", "author: Bob", "timestamp: 06.08.2026 14:34", "~~~", "", "two", ""])
		);

		const [messages, , duplicateIds] = parseMessages(source);

		expect(duplicateIds).toEqual(["1"]);
		expect(messages.size).toBe(1);
	});

	it("counts pinned messages", () => {
		const source = note(
			block(["id: 1", "author: Alice", "timestamp: 06.08.2026 14:33", "pinned: true", "~~~", "", "one", ""]),
			block(["id: 2", "author: Bob", "timestamp: 06.08.2026 14:34", "~~~", "", "two", ""])
		);

		expect(parseMessages(source)[1]).toBe(1);
	});

	// one broken block must not cost the user the rest of the file
	it("skips an unparseable block and keeps the others", () => {
		const source = note(
			block(["author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "no id", ""]),
			block(["id: 2", "author: Bob", "timestamp: 06.08.2026 14:34", "~~~", "", "fine", ""])
		);

		const [messages] = parseMessages(source);

		expect([...messages.keys()]).toEqual(["2"]);
	});
});

describe("findMessageBlocks", () => {
	/* The difference from parseMessages, and the reason the renumber uses this one: a
	   duplicated id is exactly the break the repair command exists to fix, and the message
	   map cannot represent it. */
	it("returns every block in file order, duplicates included", () => {
		const source = note(
			block(["id: 1", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "one", ""]),
			block(["id: 1", "author: Bob", "timestamp: 06.08.2026 14:34", "~~~", "", "two", ""]),
			block(["id: 5", "author: Alice", "timestamp: 06.08.2026 14:35", "~~~", "", "three", ""])
		);

		expect(findMessageBlocks(source).map(b => b.id)).toEqual(["1", "1", "5"]);
	});

	it("finds an id that is not on the first header line", () => {
		const source = note(
			block(["reply_to: 3", "id: 8", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "hi", ""])
		);

		expect(findMessageBlocks(source).map(b => b.id)).toEqual(["8"]);
	});

	// header only - a body line may well start with "id:"
	it("does not read an id out of the body", () => {
		const source = note(
			block(["id: 4", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "id: 99", ""])
		);

		expect(findMessageBlocks(source).map(b => b.id)).toEqual(["4"]);
	});

	// trimStart, matching the predicate the renumber rewrites with
	it("finds an indented id key", () => {
		const source = note(
			block(["  id: 6", "author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "hi", ""])
		);

		expect(findMessageBlocks(source).map(b => b.id)).toEqual(["6"]);
	});

	it("skips a block with no readable id without dropping the rest", () => {
		const source = note(
			block(["author: Alice", "timestamp: 06.08.2026 14:33", "~~~", "", "one", ""]),
			block(["id: 2", "author: Bob", "timestamp: 06.08.2026 14:34", "~~~", "", "two", ""])
		);

		expect(findMessageBlocks(source).map(b => b.id)).toEqual(["2"]);
	});
});
