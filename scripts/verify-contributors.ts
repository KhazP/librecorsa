/**
 * The code contributors (src/lib/contributors.ts), which the home page's About section lists: each one has a GitHub
 * profile link and pull request numbers, and the README and CREDITS.md credit every one of them with the same links,
 * so the three never drift apart.
 *
 *   npx tsx scripts/verify-contributors.ts
 */
import { readFileSync } from 'node:fs';
import { CODE_CONTRIBUTORS } from '../src/lib/contributors';
import { REPO_URL } from '../src/lib/site';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const readme = readFileSync('README.md', 'utf8');
const credits = readFileSync('CREDITS.md', 'utf8');
check('there are contributors to list', CODE_CONTRIBUTORS.length > 0, `${CODE_CONTRIBUTORS.length}`);
check('names are unique', new Set(CODE_CONTRIBUTORS.map((c) => c.name)).size === CODE_CONTRIBUTORS.length);
for (const c of CODE_CONTRIBUTORS) {
  check(`${c.name}: links to a GitHub profile`, /^https:\/\/github\.com\/[A-Za-z0-9-]+$/.test(c.url), c.url);
  check(`${c.name}: has pull requests, oldest first`, c.pulls.length > 0 && c.pulls.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || c.pulls[i - 1] < n)));
  for (const [file, text] of [['README.md', readme], ['CREDITS.md', credits]] as const) {
    check(`${c.name}: ${file} links their profile`, text.includes(`(${c.url})`));
    for (const n of c.pulls) check(`${c.name}: ${file} links #${n}`, text.includes(`[#${n}](${REPO_URL}/pull/${n})`));
  }
}
const hub = readFileSync('src/components/home/HomeHub.tsx', 'utf8');
check('the About section lists them', hub.includes('CODE_CONTRIBUTORS.map'));

if (failures.length) {
  console.error(`\n${failures.length} contributor check(s) failed`);
  process.exit(1);
}
console.log('\nAll contributor checks passed.');
