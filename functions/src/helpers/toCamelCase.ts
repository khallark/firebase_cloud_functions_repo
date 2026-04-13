export function toCamelCase(str: string) {
  return str
    .trim()                     // remove leading/trailing spaces
    .toLowerCase()              // normalize case
    .split(/\s+/)               // split by any amount of spaces
    .map((word, index) => {
      if (index === 0) return word; // first word stays lowercase
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}