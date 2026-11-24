/**
 * The home page's Lap times section (src/components/home/HomeLapTimes.tsx) is never an empty panel: rendered as the page
 * first draws it, it shows the loading card while the board is looked for, and says the lap times are offline when
 * there is no online side to ask (the same message as when the boards are off or out of reach).
 *
 * Whether there is an online side is read when the module loads, so each case draws in a process of its own.
 *
 *   npx tsx scripts/verify/verify-home-lap-times.ts
 */
import { spawnSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const DRAW = '--draw';

/** The section as the page first draws it, printed for the parent */
async function draw(): Promise<void> {
  const { HomeLapTimes } = await import('../../src/components/home/HomeLapTimes');
  process.stdout.write(
    renderToStaticMarkup(
      React.createElement(HomeLapTimes, {
        circuits: [{ id: 'spielberg', label: 'Red Bull Ring' }],
        circuit: 'spielberg',
        carTags: {},
        carChoices: [],
        carTitles: {},
        scrollRoot: { current: null },
      }),
    ),
  );
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(74)} ${detail}`);
  if (!ok) failures.push(name);
};

/** The first draw with or without an online side */
function firstDraw(api: string | undefined): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (api === undefined) delete env.NEXT_PUBLIC_ONLINE_API;
  else env.NEXT_PUBLIC_ONLINE_API = api;
  const run = spawnSync(process.execPath, [...process.execArgv, __filename, DRAW], { env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`the draw failed: ${run.stderr}`);
  return run.stdout;
}

function main(): void {
  const looking = firstDraw('https://api.example.test');
  check('while the board is looked for: the loading card, not an empty panel', looking.includes('role="status"') && looking.includes('Loading lap times'), looking.slice(0, 160));
  const none = firstDraw(undefined);
  check('with no online side: says the lap times are offline', /Lap times are offline right now/.test(none), none.slice(0, 160) || '(nothing)');
  check('and draws nothing that loads', !none.includes('Loading lap times'));

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll home lap times checks passed');
}

if (process.argv.includes(DRAW)) void draw();
else main();
