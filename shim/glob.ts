/**
 * The glob dialect of VS Code's `findFiles` and file watchers: `**`, `*`, `?`, `[...]` and nested
 * `{a,b}` groups, matched against forward-slash paths relative to a folder.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = new RegExp(`^${translate(glob.replace(/\\/g, '/'))}$`, process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
    if (cache.size > 500) cache.clear();
    cache.set(glob, re);
  }
  return re;
}

export function matchGlob(glob: string, relativePath: string): boolean {
  return globToRegExp(glob).test(relativePath.replace(/\\/g, '/'));
}

function translate(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more folders; a trailing `**` matches anything.
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) {
        out += '\\[';
      } else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = closingBrace(glob, i);
      if (end < 0) {
        out += '\\{';
      } else {
        out += `(?:${splitTop(glob.slice(i + 1, end)).map(translate).join('|')})`;
        i = end;
      }
    } else {
      out += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return out;
}

function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}
