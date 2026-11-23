/**
 * The account side's sentences reach the player in their language: every sentence the account store, the sync and
 * the account server can show is the English of a message under game.account (src/lib/account/account-words.ts maps
 * it), apart from a short list of technical answers a player of this game never meets.
 *
 *   npx tsx scripts/verify-account-words.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_NOTICES } from "../src/lib/account/account-text";
import { accountWords, isAccountMessage } from "../src/lib/account/account-words";
import { bindText } from "../src/lib/text";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Answers only a broken or hostile client gets: they stay English */
const TECHNICAL = new Set([
  "Accounts are off",
  "Body is too large",
  "Body is not valid JSON",
  "Origin not allowed",
  "Not found",
  "Unknown sign-in",
  "Unknown passkey mode",
  "Unknown challenge",
  "baseRev is required",
  'Send confirm: "delete" and removeLaps',
  "The recording is larger than 2 MB",
  "The recording doesn't match its hash",
  "The recording is not valid JSON",
]);

// The client's own sentences: the constants of the store, the API wrapper and the sync, and the sign-in notices
const clientFiles = ["src/lib/account/account-store.ts", "src/lib/account/account-api.ts", "src/lib/account/sync-engine.ts"];
const client: string[] = [];
for (const file of clientFiles) {
  for (const m of read(file).matchAll(/^(?:export )?const [A-Z_]+ = "([^"]+)";/gm)) client.push(m[1]);
}
for (const n of Object.values(AUTH_NOTICES)) client.push(n.text);
check("found the client's sentences", client.length >= 25, `${client.length}`);
for (const s of client) check(`client sentence has a message: ${s}`, isAccountMessage(s));

// The server's: failWith(ctx, "...") and error: "..." literals, and the constants they use
const serverDir = "cloudflare/api/accounts";
const server = new Set<string>();
for (const name of readdirSync(join(root, serverDir))) {
  if (!name.endsWith(".ts")) continue;
  const src = read(join(serverDir, name));
  for (const m of src.matchAll(/failWith\(ctx, (?:[^,"'`]*\? )?"([^"]+)"/g)) server.add(m[1]);
  for (const m of src.matchAll(/failWith\(ctx, '([^']+)'/g)) server.add(m[1]);
  for (const m of src.matchAll(/error: "([^"]+)"/g)) server.add(m[1]);
  for (const m of src.matchAll(/^const [A-Z_]+ = "([A-Z][^"]+ [^"]+)";/gm)) {
    if (src.includes(`failWith(ctx, ${m[0].split(" ")[1]}`)) server.add(m[1]);
  }
}
check("found the server's sentences", server.size >= 25, `${server.size}`);
for (const s of server) check(`server sentence has a message: ${s}`, TECHNICAL.has(s) || isAccountMessage(s));
// The one with a number in it
check("a sentence with a number maps", isAccountMessage("The cloud holds up to 500 best laps"));

// In another language: the mapped message, with its values; an unknown sentence comes back as it was
bindText((key, values) => `[${key}${values ? ` ${JSON.stringify(values)}` : ""}]`, () => "xx");
check("an exact sentence is translated", accountWords("Sign in first") === "[game.account.server.signInFirst]", accountWords("Sign in first"));
check("the apostrophe doesn't matter", accountWords("That sign-in isn't on this account") === "[game.account.server.signInNotHere]");
check(
  "values are carried over",
  accountWords("The cloud holds up to 500 best laps") === '[game.account.server.tooManyLaps {"count":"500"}]',
  accountWords("The cloud holds up to 500 best laps"),
);
check("an unknown sentence stays as it came", accountWords("Origin not allowed") === "Origin not allowed");
check("nothing stays nothing", accountWords(null) === null);

console.log(`account words: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
