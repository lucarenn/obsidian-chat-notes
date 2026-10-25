import type { Header } from "./types";

/* Reactions are stored as one header line, in the order they were first added:

	reactions: 👍 3, ❤️, :custom:

   An entry is a token (no whitespace, no comma) optionally followed by a count; a missing
   count means 1. Any token is accepted, so imported custom emoji can be kept as text. */

export interface Reaction {
	emoji: string;
	count: number;
}

export type ReactionChange = "add" | "remove";

export const REACTIONS_KEY = "reactions";

const MAX_TOKEN_LENGTH = 64;

export function isValidReactionToken(token: string): boolean {
	return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && !/[\s,]/.test(token);
}

// lenient: malformed entries are skipped, and repeated tokens merge into the first one
export function parseReactions(value: string | undefined): Reaction[] {
	if (!value) return [];

	const reactions: Reaction[] = [];

	for (const entry of value.split(",")) {
		const parts = entry.trim().split(/\s+/);
		const emoji = parts[0] ?? "";
		if (!isValidReactionToken(emoji) || parts.length > 2) continue;

		const rawCount = parts[1];
		if (rawCount !== undefined && !/^\d+$/.test(rawCount)) continue;

		const count = rawCount === undefined ? 1 : Number(rawCount);
		if (!Number.isSafeInteger(count) || count < 1) continue;

		const existing = reactions.find(r => r.emoji === emoji);
		if (existing) existing.count += count;
		else reactions.push({ emoji, count });
	}

	return reactions;
}

export function serializeReactions(reactions: Reaction[]): string {
	return reactions
		.filter(r => r.count > 0)
		.map(r => r.count === 1 ? r.emoji : `${r.emoji} ${String(r.count)}`)
		.join(", ");
}

export function readReactions(header: Header): Reaction[] {
	return parseReactions(header.extra[REACTIONS_KEY]);
}

export function addReaction(reactions: Reaction[], emoji: string): Reaction[] {
	if (!reactions.some(r => r.emoji === emoji)) {
		return [...reactions, { emoji, count: 1 }];
	}
	return reactions.map(r => r.emoji === emoji ? { emoji, count: r.count + 1 } : r);
}

export function removeReaction(reactions: Reaction[], emoji: string): Reaction[] {
	return reactions
		.map(r => r.emoji === emoji ? { emoji, count: r.count - 1 } : r)
		.filter(r => r.count > 0);
}
