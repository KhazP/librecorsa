/**
 * The docs site's pages (docs-site/pages.mjs) against the repository: every published page exists and has a title, and
 * every link in one resolves to a page, a file or a path on GitHub. The docs deploy only runs for docs changes, so
 * without this a push that moves a linked file would pass and the next docs edit would fail to deploy.
 *
 *   npx tsx scripts/verify-docs-site.ts
 */
import { spawnSync } from 'node:child_process';

const run = spawnSync(process.execPath, ['docs-site/scripts/sync-docs.mjs', '--check'], { encoding: 'utf8' });
const ok = run.status === 0;
const detail = (ok ? run.stdout : run.stderr).trim().split('\n').find((line) => /^(docs:|Error)/.test(line)) ?? '';
console.log(`${ok ? 'PASS' : 'FAIL'}  ${'every docs page builds and every link in one resolves'.padEnd(64)} ${detail}`);
if (!ok) {
  console.error(run.stderr);
  process.exit(1);
}
