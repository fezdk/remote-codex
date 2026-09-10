// Shared by the composer and the bridge: never infer skills from ordinary words.
export const commands = ['rename', 'compact', 'status', 'goal', 'help'];
const reserved = new Set([...commands, 'model']);

export function commandOf(text) {
  const match = text.match(/^\s*\/(rename|compact|status|goal|help)(?=\s|$)/);
  return match ? { name: match[1], argument: text.slice(match[0].length).trim(), start: match[0].indexOf('/'), end: match[0].length } : null;
}

export function skillMentions(text, skills) {
  const names = new Map();
  for (const skill of skills) names.set(skill.name, names.has(skill.name) ? null : skill);
  const ranges = [];
  // Inline and fenced code are literal, including an unfinished code span.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    const start = i;
    while (text[i] === '`') i++;
    const end = text.indexOf(text.slice(start, i), i);
    i = end < 0 ? text.length : end + i - start;
    ranges.push([start, i]); i--;
  }
  const result = [];
  let range = 0;
  for (const match of text.matchAll(/(^|[\s(])([/$])([a-zA-Z0-9][a-zA-Z0-9_.:-]*)/g)) {
    const start = match.index + match[1].length;
    const name = match[3].replace(/[.:]+$/, '');
    const end = start + 1 + name.length;
    while (range < ranges.length && ranges[range][1] <= start) range++;
    if (ranges[range]?.[0] <= start || /[\w/\\-]/.test(text[end] || '') || match[2] === '/' && reserved.has(name)) continue;
    const skill = names.get(name);
    if (skill) result.push({ start, end, name, skill });
  }
  return result;
}
