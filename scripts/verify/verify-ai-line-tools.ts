/**
 * The line tools' judging rules (scripts/ai/lib/line-judging.ts) and car lookup (scripts/ai/lib/physics-lap.ts): what a
 * clean lap is, when a judge unclean on the current line is excused, and that every car is checked as itself.
 *
 *   npx tsx scripts/verify/verify-ai-line-tools.ts
 */
import { candidatePasses, excusedJudges, isCleanLap, noWorseLap, timedLaps, type JudgedLap } from '../ai/lib/line-judging';
import { physicsLapVehicle } from '../ai/lib/physics-lap';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};
const lap = (lapS: number, offTrackFrames = 0, wallHits = 0, maxErrM = 1): JudgedLap => ({ lapS, offTrackFrames, wallHits, maxErrM });

check('a finished lap, on the road and the line, is clean', isCleanLap(lap(90)));
check('12 frames off the road is still clean, 13 is not', isCleanLap(lap(90, 12)) && !isCleanLap(lap(90, 13)));
check('a barrier hit is never clean', !isCleanLap(lap(90, 0, 1)));
check('an unfinished lap is never clean', !isCleanLap(lap(Infinity)));
check('2.5 m off the line is not clean (3 m is the check\'s own limit)', !isCleanLap(lap(90, 0, 0, 2.5)) && isCleanLap(lap(90, 0, 0, 2.5), 3));

check('no worse: fewer frames off and hits', noWorseLap(lap(91, 40, 1), lap(90, 50, 1)));
check('worse: more frames off', !noWorseLap(lap(89, 60), lap(90, 50)));
check('worse: unfinished where the current line finished', !noWorseLap(lap(Infinity), lap(90, 50)));

// The LC26 through Monaco's barriers: unclean on the current line, the f12026-car clean
const monaco = [lap(78), lap(Infinity, 300, 4)];
check('a judge unclean on the current line is excused when another is clean', excusedJudges(monaco, false).join() === 'false,true');
check('...but never with --strict', excusedJudges(monaco, true).join() === 'false,false');
check('nobody is excused when no judge is clean on the current line', excusedJudges([lap(Infinity, 30), lap(90, 20)], false).every((e) => !e));
const ex = excusedJudges(monaco, false);
check('an excused judge may stay unclean if no worse', candidatePasses([lap(77.5), lap(Infinity, 200, 3)], monaco, ex));
check('an excused judge far worse fails the candidate (Barbagallo: 1403 frames off)', !candidatePasses([lap(77.5), lap(Infinity, 1403, 4)], monaco, ex));
check('with --strict an unclean judge fails the candidate', !candidatePasses([lap(77.5), lap(Infinity, 200, 3)], monaco, excusedJudges(monaco, true)));
check('the clean judge must stay clean', !candidatePasses([lap(77.5, 20), lap(Infinity, 200, 3)], monaco, ex));
check('an excused judge\'s time is left out of the ranking', timedLaps([lap(77.5), lap(Infinity, 200, 3)], ex) === 77.5);
check('every judge\'s time counts otherwise', timedLaps([lap(77.5), lap(80)], [false, false]) === 157.5);

check('a road car is checked as itself, not as the f12026-car', physicsLapVehicle('liana') === 'liana');
check('the line aliases name their cars', physicsLapVehicle('f1') === 'f12026-car' && physicsLapVehicle('gt3') === 'amg-gt3');
let threw = false;
try {
  physicsLapVehicle('lianna' as never);
} catch {
  threw = true;
}
check('an unknown car id is refused, not driven as the f12026-car', threw);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
