export const POPULAR_REACTIONS = [
  "😂", "😁", "😭", "✍️", "🔥", "❤️‍🔥", "😞", "❤️",
  "😨", "💯", "🙏", "🤬", "🫡", "👍", "🥴", "😐",
  "🌭", "🤮", "💅", "🤯", "🗿", "☃️",// "👎", "🥰",
  "👏", "🤔", "😱", "🎉", "🤩", "💩", "👌", "🕊️",
  "🤡", "🥱", "😍", "🐳", "🌚", "⚡", "🍌", "🏆",
  "💔", "🙂", "🍓", "🍾", "💋", "🖕", "😈", "😴",
  "🤓", "👻", "👱", "👀", "🎃", "🙈", "😇", "🤝",
  "🤗", "🎅", "🎄", "😜", "🆒", "💘", "🙉", "🦄",
  "🙂", "💊", "🙊", "😎", "👾", "🤷‍♂️", "🤷", "🤷‍♀️",
  "😡",
];

export const FAILED_REACTIONS = [
  "👎",
]

export function getRandomReaction(): string {
  return POPULAR_REACTIONS[Math.floor(Math.random() * POPULAR_REACTIONS.length)];
}

export function getRandomFailedReaction(): string {
  return FAILED_REACTIONS[Math.floor(Math.random() * FAILED_REACTIONS.length)];
}
