/* Builders for chat-note text, shared by the format tests.

   The fence is built rather than written literally so a fixture body can hold an ordinary
   three-backtick code block without fighting the template syntax. */

export const FENCE = "`".repeat(4);

// one message block, laid out exactly as Message.toString() writes it
export function block(lines: string[]): string {
	return [FENCE + "chat-message", ...lines, FENCE].join("\n");
}

/* A whole chat note: frontmatter, a blank line, the blocks, and the trailing newline a file
   ends on. The frontmatter matters for the renumber tests - it is what must survive
   untouched, since the write starts at the first block. */
export function note(...blocks: string[]): string {
	return [
		"---",
		"type: chat-note",
		"author: Alice",
		"---",
		"",
		...blocks,
		""
	].join("\n");
}

// the line the first message block opens on in a note() document
export const FIRST_BLOCK_LINE = 5;
