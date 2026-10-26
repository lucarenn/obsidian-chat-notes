import type { Message } from "./types";
import { readReactions } from "./reactions";
import { parseMessages } from "./util";

/* What a search filters by. Only plain text for now; further conditions (a date range, "has
   reactions", an author) become optional fields here, read from the query by parseSearchQuery
   and combined with AND in messageMatches - nothing outside this file has to change. */
export interface SearchQuery {
	text: string;	// lower-cased; matched as a substring
}

// null for a blank query: no filter at all, rather than one that matches everything
export function parseSearchQuery(raw: string): SearchQuery | null {
	const text = raw.trim().toLowerCase();
	if (text === "") return null;
	return { text };
}

/* Each field is checked on its own, so a phrase can't match across the end of the author and
   the start of the body. The body is the raw markdown, the way Ctrl+F would see it. */
export function messageMatches(message: Message, query: SearchQuery): boolean {
	const { header } = message;
	const fields = [
		message.content,
		header.author,
		header.timestamp,
		...readReactions(header).map(r => r.emoji)
	];

	return fields.some(field => field.toLowerCase().includes(query.text));
}

// every filter a chat note can have on at once; a message must pass all of them to show
export interface MessageFilter {
	pinnedOnly: boolean;
	query?: SearchQuery;
}

export function isFilteredOut(message: Message, filter: MessageFilter): boolean {
	if (filter.pinnedOnly && message.header.extra.pinned !== "true") return true;
	if (filter.query && !messageMatches(message, filter.query)) return true;
	return false;
}

/* The line ranges (0-based, inclusive, fence lines included) the filter hides in `text`, for
   the Live Preview extension to collapse. Consecutive hidden blocks with only blank lines
   between them become one range, blank lines included: those lines would otherwise still
   render, one empty line per hidden message, and add up to the same gap the extension is
   there to remove. */
export function hiddenLineRanges(text: string, filter: MessageFilter): [number, number][] {
	const [messages] = parseMessages(text);
	const lines = text.split("\n");

	const hidden = Array.from(messages.values())
		.filter(entry => isFilteredOut(entry.message, filter))
		.sort((a, b) => a.startLine - b.startLine);

	const ranges: [number, number][] = [];
	for (const { startLine, endLine } of hidden) {
		const last = ranges[ranges.length - 1];
		const onlyBlankBetween = last !== undefined
			&& lines.slice(last[1] + 1, startLine).every(line => line.trim() === "");

		if (last && onlyBlankBetween) last[1] = endLine;
		else ranges.push([startLine, endLine]);
	}

	return ranges;
}
