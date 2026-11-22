/**
 * /.well-known/security.txt (src/lib/security-txt.ts) against RFC 9116: the required fields once each, an Expires
 * under a year ahead that a deploy renews, https everywhere and the canonical address on librecorsa.org.
 *
 *   npx tsx scripts/verify-security-txt.ts
 */
import { SECURITY_TXT_VALID_DAYS, securityTxt } from '../src/lib/security-txt';
import { CONTACT_EMAIL, SECURITY_REPORT_URL } from '../src/lib/site';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const builtAt = new Date('2026-11-23T12:34:56.789Z');
const text = securityTxt(builtAt);
const fields = text
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), line.slice(at + 2)] as const;
  });
const all = (name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);

check('every line is "Field: value"', fields.every(([k, v]) => /^[A-Za-z-]+$/.test(k) && v.length > 0));
check('ends with a newline', text.endsWith('\n'));
check('the advisory form is a contact', all('Contact').includes(SECURITY_REPORT_URL));
check('the contact address is a mailto contact', all('Contact').includes(`mailto:${CONTACT_EMAIL}`));
check('every web address is https', fields.every(([k, v]) => (k === 'Contact' && v.startsWith('mailto:')) || !/^[a-z]+:/.test(v) || v.startsWith('https://')));

const expires = all('Expires');
check('Expires appears exactly once', expires.length === 1, expires.join(', '));
const at = Date.parse(expires[0] ?? '');
check('Expires is an RFC 3339 UTC time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires[0] ?? ''), expires[0]);
const days = (at - builtAt.getTime()) / 86_400_000;
check('Expires is the valid-days window after the build', Math.abs(days - SECURITY_TXT_VALID_DAYS) < 1 / 86_400, `${days.toFixed(3)} days`);
check('Expires is under a year ahead (RFC 9116 2.5.5)', days > 0 && days < 365);

const canonical = all('Canonical');
check('Canonical is the file on librecorsa.org', canonical.length === 1 && canonical[0] === 'https://librecorsa.org/.well-known/security.txt', canonical.join(', '));
check('Policy points at SECURITY.md', all('Policy').length === 1 && all('Policy')[0].endsWith('/SECURITY.md'));
check('Preferred-Languages appears at most once', all('Preferred-Languages').length <= 1);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll security.txt checks passed.');
