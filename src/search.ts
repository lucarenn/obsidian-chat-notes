import type { Message } from "./types";
import { readReactions } from "./reactions";
import { parseMessages } from "./util";
import { parseDateValue, parseMessageTime, TimeRange } from "./search-dates";
import { emojiByName, emojiName } from "./emoji-data";

/* The filters a query can hold, Discord style: `key:value`, with the value in quotes when it
   has spaces (author:"Alice Smith"). They combine with AND, and with whatever free text is
   left over. The first name is the one suggested; the rest are aliases. */
export const SEARCH_FILTERS = [
	{ key: "author", names: ["author", "from"], hint: "Messages by an author" },
	{ key: "content", names: ["content", "contains"], hint: "Text in the message itself" },
	{ key: "time", names: ["time", "during"], hint: "Messages from a date or time" },
	{ key: "reaction", names: ["reaction"], hint: "Messages with a reaction" },
	{ key: "before", names: ["before", "older"], hint: "Messages before a date" },
	{ key: "after", names: ["after", "newer"], hint: "Messages after a date" }
] as const;

export type SearchFilterKey = typeof SEARCH_FILTERS[number]["key"];

const FILTER_BY_NAME = new Map<string, SearchFilterKey>(
	SEARCH_FILTERS.flatMap(filter => filter.names.map(name => [name, filter.key] as const))
);

export function filterKeyOf(name: string): SearchFilterKey | undefined {
	return FILTER_BY_NAME.get(name.toLowerCase());
}

/* `name:value` at the start of a word. An unclosed quote runs to the end, so a value that is
   still being typed already filters. A name that isn't a filter (https://, 14:33) is text. */
const FILTER_PATTERN = /(?<=^|\s)([a-z]+):("[^"]*"?|\S*)/gi;

// a time: condition - a span when the value is a date, otherwise text the timestamp contains
type TimeCondition = { range: TimeRange } | { text: string };

/* Lists are ANDed, except `authors`: a message has one author, so repeating author: means
   either of them. Every string is lower-cased. */
export interface SearchQuery {
	text?: string;			// free text, matched against every field
	content: string[];		// each must be in the body
	authors: string[];		// one of them must be in the author
	times: TimeCondition[];
	reactions: ReactionCondition[];	// each must match one of the reactions
	before?: number;		// the timestamp is earlier than this (ms)
	after?: number;			// the timestamp is this or later (ms)
	invalid: string[];		// filters whose value didn't parse; ignored, shown in the bar
}

// reactions are compared without the emoji variation selector, which ❤ and ❤️ differ by
function normalizeEmoji(value: string): string {
	return value.replace(/\uFE0F/g, "").toLowerCase();
}

/* A reaction: condition. A value that is a known emoji or emoji name (fire, :fire:) means
   exactly that emoji; anything else is text a reaction's token or name contains. */
type ReactionCondition = { emoji: string } | { text: string };

function parseReactionCondition(value: string): ReactionCondition {
	const emoji = emojiByName(value) ?? (emojiName(value) !== undefined ? value : undefined);
	return emoji !== undefined ? { emoji: normalizeEmoji(emoji) } : { text: normalizeEmoji(value) };
}

/* What a stored reaction is found by: its emoji, its token and its name. Either form may be
   stored - the picker writes the emoji, a Discord export may hold :fire: - and each finds the other. */
function reactionTerms(token: string): { emoji?: string; names: string[] } {
	const stored = normalizeEmoji(token);
	const known = emojiName(stored);
	const name = known ?? stored.replace(/^:|:$/g, "");
	const emoji = known !== undefined ? stored : emojiByName(name);
	return { emoji: emoji && normalizeEmoji(emoji), names: [stored, name] };
}

function reactionMatches(token: string, condition: ReactionCondition): boolean {
	const terms = reactionTerms(token);
	return "emoji" in condition
		? terms.emoji === condition.emoji
		: terms.names.some(term => term.includes(condition.text));
}

/* null for a query that filters nothing: blank, or only filters with no value yet, so typing
   "author:" doesn't flash the whole note empty. `now` anchors the relative dates (7d). */
export function parseSearchQuery(raw: string, now: Date = new Date()): SearchQuery | null {
	const query: SearchQuery = { content: [], authors: [], times: [], reactions: [], invalid: [] };
	const textParts: string[] = [];
	let last = 0;

	for (const match of raw.matchAll(FILTER_PATTERN)) {
		const key = filterKeyOf(match[1] ?? "");
		if (!key) continue;

		textParts.push(raw.slice(last, match.index));
		last = (match.index ?? 0) + match[0].length;

		const quoted = match[2] ?? "";
		const value = quoted.replace(/^"/, "").replace(/"$/, "").trim();
		if (value === "") continue;

		const lower = value.toLowerCase();

		switch (key) {
			case "author": query.authors.push(lower); break;
			case "content": query.content.push(lower); break;
			case "reaction": query.reactions.push(parseReactionCondition(value)); break;

			case "time": {
				const range = parseDateValue(value, now);
				// a relative value is an instant; as a period it means "since then"
				if (range && range.start === range.end) {
					query.times.push({ range: { start: range.start, end: Infinity } });
				} else if (range) {
					query.times.push({ range });
				} else {
					query.times.push({ text: lower });
				}
				break;
			}

			// exclusive of the period named, and the strictest one wins when repeated
			case "before":
			case "after": {
				const range = parseDateValue(value, now);
				if (!range) {
					query.invalid.push(`${match[1] ?? key}:${value}`);
				} else if (key === "before") {
					query.before = Math.min(query.before ?? Infinity, range.start);
				} else {
					query.after = Math.max(query.after ?? -Infinity, range.end);
				}
				break;
			}
		}
	}
	textParts.push(raw.slice(last));

	// the text either side of a filter, joined by one space; spacing inside a part is kept
	const text = textParts.map(part => part.trim()).filter(part => part !== "").join(" ").toLowerCase();
	if (text !== "") query.text = text;

	const filters = query.content.length + query.authors.length + query.times.length
		+ query.reactions.length + query.invalid.length;
	const hasDates = query.before !== undefined || query.after !== undefined;
	if (text === "" && filters === 0 && !hasDates) return null;
	return query;
}

/* Free text checks each field on its own, so a phrase can't match across the end of the author
   and the start of the body. The body is the raw markdown, the way Ctrl+F would see it. */
export function messageMatches(message: Message, query: SearchQuery): boolean {
	const { header } = message;
	const content = message.content.toLowerCase();
	const author = header.author.toLowerCase();
	const timestamp = header.timestamp.toLowerCase();
	const tokens = readReactions(header).map(r => r.emoji);

	if (query.text !== undefined) {
		const text = query.text;
		const fields = [content, author, timestamp, ...tokens.map(normalizeEmoji)];
		if (!fields.some(field => field.includes(text))) return false;
	}

	if (!query.content.every(part => content.includes(part))) return false;
	if (query.authors.length > 0 && !query.authors.some(name => author.includes(name))) return false;
	if (!query.reactions.every(wanted => tokens.some(token => reactionMatches(token, wanted)))) return false;

	const needsTime = query.before !== undefined || query.after !== undefined
		|| query.times.some(condition => "range" in condition);
	// a message whose timestamp can't be read can't be shown to fall inside a date filter
	const time = needsTime ? parseMessageTime(header.timestamp) : null;
	if (needsTime && time === null) return false;

	if (time !== null) {
		if (query.before !== undefined && time >= query.before) return false;
		if (query.after !== undefined && time < query.after) return false;
	}

	return query.times.every(condition => "range" in condition
		? time !== null && time >= condition.range.start && time < condition.range.end
		: timestamp.includes(condition.text));
}

/* Suggestions for the search field */

// what the field can suggest as a value, collected from the note (see collectSuggestionValues)
export interface SuggestionValues {
	authors: string[];
	reactions: string[];
}

// the authors in file order, the reactions most used first
export function collectSuggestionValues(messages: Iterable<Message>): SuggestionValues {
	const authors = new Set<string>();
	const reactionCounts = new Map<string, number>();

	for (const message of messages) {
		const author = message.header.author.trim();
		if (author) authors.add(author);
		for (const { emoji, count } of readReactions(message.header)) {
			reactionCounts.set(emoji, (reactionCounts.get(emoji) ?? 0) + count);
		}
	}

	const reactions = Array.from(reactionCounts).sort((a, b) => b[1] - a[1]).map(([emoji]) => emoji);
	return { authors: Array.from(authors), reactions };
}

export interface SearchSuggestion {
	label: string;
	hint?: string;
	// the span of the field's text it replaces, and what with
	from: number;
	to: number;
	insert: string;
}

// the date values offered for before:/after:/time:, with a hint per filter
const DATE_SUGGESTIONS: { value: string; before: string; after: string; time: string }[] = [
	{ value: "today", before: "Before today", after: "After today", time: "Today" },
	{ value: "yesterday", before: "Before yesterday", after: "Since today", time: "Yesterday" },
	{ value: "7d", before: "More than 7 days ago", after: "In the last 7 days", time: "In the last 7 days" },
	{ value: "30d", before: "More than 30 days ago", after: "In the last 30 days", time: "In the last 30 days" },
	{ value: "1y", before: "More than a year ago", after: "In the last year", time: "In the last year" }
];

// a value with a space or a quote in it has to be quoted, or it would end at the space
function quoteValue(value: string): string {
	return /[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

/* What to suggest for the word at the caret: the filter names its start could become, or the
   values of the filter it already names. Nothing for free text, and nothing on a blank word
   unless the whole field is blank - otherwise Enter after a typed word and a space would pick
   a suggestion instead of searching. */
export function searchSuggestions(input: string, caret: number, values: SuggestionValues): SearchSuggestion[] {
	const before = input.slice(0, caret);
	// the rest of the word the caret is in goes too, so a pick never leaves half a word behind
	const to = caret + (/^\S*/.exec(input.slice(caret))?.[0].length ?? 0);

	// a filter with its value being typed; an unclosed quote may hold spaces
	const valueMatch = /(?:^|\s)([a-z]+):("[^"]*|\S*)$/i.exec(before);
	const key = valueMatch ? filterKeyOf(valueMatch[1] ?? "") : undefined;

	if (valueMatch && key) {
		const typed = (valueMatch[2] ?? "").replace(/^"/, "").toLowerCase();
		const name = valueMatch[1] ?? key;
		const from = caret - valueMatch[0].trimStart().length;

		const pick = (value: string, hint?: string): SearchSuggestion => ({
			label: value, hint, from, to, insert: `${name}:${quoteValue(value)} `
		});

		switch (key) {
			case "author":
				return values.authors.filter(a => a.toLowerCase().includes(typed)).map(a => pick(a));
			case "reaction":
				return values.reactions
					.filter(r => reactionTerms(r).names.some(term => term.includes(normalizeEmoji(typed))))
					.map(r => {
						const name = emojiName(r);
						return pick(r, name !== undefined ? `:${name}:` : undefined);
					});
			case "before":
			case "after":
			case "time":
				return DATE_SUGGESTIONS.filter(d => d.value.startsWith(typed)).map(d => pick(d.value, d[key]));
			case "content":
				return [];
		}
	}

	const word = /\S*$/.exec(before)?.[0] ?? "";
	if (word.includes(":") || (word === "" && input.trim() !== "")) return [];

	const from = caret - word.length;
	const lower = word.toLowerCase();
	const suggestions: SearchSuggestion[] = [];
	for (const filter of SEARCH_FILTERS) {
		// the alias when that is what is being typed ("old" -> older:), the main name otherwise
		const name = filter.names.find((n: string) => n.startsWith(lower));
		if (!name) continue;
		suggestions.push({ label: `${name}:`, hint: filter.hint, from, to, insert: `${name}:` });
	}
	return suggestions;
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
