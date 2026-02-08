export const POPULAR_REACTIONS = [
  "🌭", "🤮", "💅", "🤯", "🗿", "☃️", "👎", "🥰",
  "👏", "🤔", "😱", "🎉", "🤩", "💩", "👌", "🕊️",
  "🤡", "🤭", "😍", "🐳", "🌚", "⚡", "🍌", "🏆",
  "💔", "🙂", "🍓", "🍾", "💋", "🖕", "😈", "😴",
  "🤓", "👻", "👱", "👀", "🎃", "🙈", "😇", "🤝",
  "🤗", "🤶", "🎄", "😜", "🆒", "💘", "🙉", "🦄",
  "🙂", "💊", "🙊", "😎", "👾", "🤷‍♂️", "🤷", "🤷‍♀️",
  "😡",
];

export function getRandomReaction(): string {
  return POPULAR_REACTIONS[Math.floor(Math.random() * POPULAR_REACTIONS.length)];
}
