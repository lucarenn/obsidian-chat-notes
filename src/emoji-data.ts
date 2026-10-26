// fully-qualified forms throughout, so a picked emoji matches the same one picked again

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];

/* Each emoji with its Discord name (without the colons), which is what a Discord export stores
   and what the picker and the reaction: filter search by. */
export const EMOJI_CATEGORIES: { name: string; emoji: [string, string][] }[] = [
	{
		name: "Smileys",
		emoji: [
			["😀", "grinning"], ["😃", "smiley"], ["😄", "smile"], ["😁", "grin"], ["😆", "laughing"], ["😅", "sweat_smile"],
			["🤣", "rofl"], ["😂", "joy"], ["🙂", "slight_smile"], ["🙃", "upside_down"], ["😉", "wink"], ["😊", "blush"],
			["😇", "innocent"], ["🥰", "smiling_face_with_3_hearts"], ["😍", "heart_eyes"], ["🤩", "star_struck"], ["😘", "kissing_heart"], ["😋", "yum"],
			["😛", "stuck_out_tongue"], ["😜", "stuck_out_tongue_winking_eye"], ["🤪", "zany_face"], ["🤔", "thinking"], ["🤨", "face_with_raised_eyebrow"], ["😐", "neutral_face"],
			["😑", "expressionless"], ["😶", "no_mouth"], ["🙄", "rolling_eyes"], ["😏", "smirk"], ["😬", "grimacing"], ["😌", "relieved"],
			["😴", "sleeping"], ["🤯", "exploding_head"], ["🥳", "partying_face"], ["😎", "sunglasses"], ["🤓", "nerd"], ["🧐", "face_with_monocle"],
			["😕", "confused"], ["😟", "worried"], ["😮", "open_mouth"], ["😯", "hushed"], ["😲", "astonished"], ["😳", "flushed"],
			["🥺", "pleading_face"], ["😢", "cry"], ["😭", "sob"], ["😱", "scream"], ["😤", "triumph"], ["😡", "rage"],
			["🤬", "face_with_symbols_over_mouth"], ["💀", "skull"], ["🤡", "clown"], ["👀", "eyes"]
		]
	},
	{
		name: "Gestures",
		emoji: [
			["👍", "thumbsup"], ["👎", "thumbsdown"], ["👌", "ok_hand"], ["✌️", "v"], ["🤞", "fingers_crossed"], ["🤟", "love_you_gesture"],
			["🤘", "metal"], ["🤙", "call_me"], ["👈", "point_left"], ["👉", "point_right"], ["👆", "point_up_2"], ["👇", "point_down"],
			["☝️", "point_up"], ["✋", "raised_hand"], ["👋", "wave"], ["👏", "clap"], ["🙌", "raised_hands"], ["🤝", "handshake"],
			["🙏", "pray"], ["💪", "muscle"], ["🫡", "saluting_face"], ["🤷", "person_shrugging"], ["🤦", "person_facepalming"], ["🙋", "person_raising_hand"]
		]
	},
	{
		name: "Hearts",
		emoji: [
			["❤️", "heart"], ["🧡", "orange_heart"], ["💛", "yellow_heart"], ["💚", "green_heart"], ["💙", "blue_heart"], ["💜", "purple_heart"],
			["🖤", "black_heart"], ["🤍", "white_heart"], ["🤎", "brown_heart"], ["💔", "broken_heart"], ["❣️", "heart_exclamation"], ["💕", "two_hearts"],
			["💖", "sparkling_heart"], ["💯", "100"]
		]
	},
	{
		name: "Objects",
		emoji: [
			["🔥", "fire"], ["✨", "sparkles"], ["⭐", "star"], ["🌟", "star2"], ["⚡", "zap"], ["🎉", "tada"],
			["🎊", "confetti_ball"], ["🎁", "gift"], ["🏆", "trophy"], ["🥇", "first_place"], ["🚀", "rocket"], ["💡", "bulb"],
			["📌", "pushpin"], ["📎", "paperclip"], ["✏️", "pencil2"], ["📝", "pencil"], ["📅", "date"], ["⏰", "alarm_clock"],
			["🔒", "lock"], ["🔑", "key"], ["💰", "moneybag"], ["☕", "coffee"], ["🍕", "pizza"], ["🍺", "beer"]
		]
	},
	{
		name: "Symbols",
		emoji: [
			["✅", "white_check_mark"], ["☑️", "ballot_box_with_check"], ["✔️", "heavy_check_mark"], ["❌", "x"], ["❎", "negative_squared_cross_mark"], ["⚠️", "warning"],
			["❓", "question"], ["❗", "exclamation"], ["‼️", "bangbang"], ["⁉️", "interrobang"], ["➕", "heavy_plus_sign"], ["➖", "heavy_minus_sign"],
			["🔴", "red_circle"], ["🟠", "orange_circle"], ["🟡", "yellow_circle"], ["🟢", "green_circle"], ["🔵", "blue_circle"], ["🟣", "purple_circle"],
			["⚫", "black_circle"], ["⚪", "white_circle"], ["🆗", "ok"], ["🆕", "new"], ["🔝", "top"], ["💤", "zzz"]
		]
	}
];

// compared without the variation selector, which ❤ and ❤️ differ by
const bare = (value: string) => value.replace(/\uFE0F/g, "");

const NAME_BY_EMOJI = new Map<string, string>();
const EMOJI_BY_NAME = new Map<string, string>();
for (const category of EMOJI_CATEGORIES) {
	for (const [emoji, name] of category.emoji) {
		NAME_BY_EMOJI.set(bare(emoji), name);
		EMOJI_BY_NAME.set(name, emoji);
	}
}

// "fire" for 🔥; undefined for an emoji the picker doesn't list
export function emojiName(emoji: string): string | undefined {
	return NAME_BY_EMOJI.get(bare(emoji));
}

// 🔥 for "fire" or ":fire:", in any case
export function emojiByName(name: string): string | undefined {
	return EMOJI_BY_NAME.get(name.toLowerCase().replace(/^:|:$/g, ""));
}
