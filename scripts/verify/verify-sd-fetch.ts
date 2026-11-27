/**
 * The Speed Dreams fetcher (scripts/mods/lib/sd-fetch.ts), offline: what it refuses and what it checks.
 *
 * - paths: an archive's or a tree's path is taken only as a safe relative one, a name from a source's XML only as a
 *   plain file name;
 * - archives: a zip with an entry outside its folder (`..`, absolute, a drive, a backslash) or a link is refused whole;
 * - git: a tree holding a link is refused before anything is written, a plain one is written out byte for byte, and a
 *   blob's id is git's own;
 * - provenance: a folder's .sd-source.json counts only inside the cache;
 * - the cached shared data: a file changed in the cache is fetched again at the pinned commit (when the cache holds
 *   speed-dreams-data's clone; skipped otherwise);
 * - downloads: only over https.
 *
 *   npx tsx scripts/verify/verify-sd-fetch.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "../../src/lib/mods/zip-reader";
import {
  download,
  extractZip,
  gitBlobId,
  plainFileName,
  readSdSource,
  safeRelative,
  SD_DATA_DIR,
  sdDataFiles,
  SOURCE_FILE,
  writeTree,
} from "../mods/lib/sd-fetch";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(84)} ${detail}`);
  if (!ok) failed++;
}
const tmp = mkdtempSync(join(tmpdir(), "sd-fetch-"));
const refusal = async (f: () => unknown): Promise<string> => {
  try {
    await f();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

// --- Paths ------------------------------------------------------------------------------------------------------------

const unsafe = ["../x", "a/../../x", "/etc/passwd", "C:/x", "c:x", "a\\..\\x", "a//b", "./a", "a/.", "", "a\u0000b", "a:stream", "a\nb"];
const bad = unsafe.filter((p) => safeRelative(p) !== null);
check(
  "unsafe paths are refused: .., absolute, a drive, a backslash, an empty or . part, a control character",
  !bad.length,
  bad.map((p) => JSON.stringify(p)).join(", "),
);
check("safe paths are kept as they are", safeRelative("data/textures/road.png") === "data/textures/road.png" && safeRelative("a b/c-d_e.f") === "a b/c-d_e.f");
const names = ["..", ".", "../../x.wav", "objects/wheel0.acc", "a\\b", "C:x", ""].filter((n) => plainFileName(n));
check("a name from a car's XML must be a plain file name", !names.length && plainFileName("engine-1.wav") && plainFileName("LS-GT2"), names.join(", "));

// --- Archives ----------------------------------------------------------------------------------------------------------

/** A stored zip of these entries; `link` marks an entry as a Unix symbolic link */
function zip(entries: { name: string; data: string; link?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }) : []);

async function main(): Promise<void> {
  {
    const out = join(tmp, "zip-ok");
    mkdirSync(out);
    const n = await extractZip(
      zip([
        { name: "brno/brno.xml", data: "<params/>" },
        { name: "brno/__MACOSX/._x", data: "" },
        { name: "brno/sub/a.png", data: "png" },
      ]),
      out,
      "test",
    );
    check("a plain zip unpacks into its folder", n === 2 && readFileSync(join(out, "brno", "sub", "a.png"), "utf8") === "png", files(out).join(", "));
  }
  for (const [what, name] of [
    ["a .. path", "brno/../../escaped.txt"],
    ["an absolute path", "/tmp/escaped.txt"],
    ["a drive", "C:/escaped.txt"],
    ["a backslash", "brno\\..\\..\\escaped.txt"],
  ] as const) {
    const out = join(tmp, `zip-${what.replace(/\W+/g, "-")}`);
    mkdirSync(out);
    const why = await refusal(() =>
      extractZip(
        zip([
          { name: "brno/ok.txt", data: "ok" },
          { name, data: "x" },
        ]),
        out,
        "test",
      ),
    );
    check(`a zip with ${what} is refused`, /unsafe path/.test(why) && !existsSync(join(tmp, "escaped.txt")), why);
  }
  {
    const out = join(tmp, "zip-link");
    mkdirSync(out);
    const why = await refusal(() =>
      extractZip(
        zip([
          { name: "car/car.xml", data: "<params/>" },
          { name: "car/readme.txt", data: "/etc/passwd", link: true },
        ]),
        out,
        "test",
      ),
    );
    check("a zip holding a link is refused, and makes no link", /a link/.test(why) && !files(out).some((f) => lstatSync(join(out, f)).isSymbolicLink()), why);
  }
  {
    const out = join(tmp, "zip-pick");
    mkdirSync(out);
    const n = await extractZip(
      zip([
        { name: "car/car.xml", data: "x" },
        { name: "other/y.txt", data: "y" },
      ]),
      out,
      "test",
      (p) => (p.startsWith("car/") ? p.slice(4) : null),
    );
    check("a car's zip keeps only its <car>/ folder's files", n === 1 && existsSync(join(out, "car.xml")) && !existsSync(join(out, "y.txt")));
  }

  // --- git -----------------------------------------------------------------------------------------------------------------

  const hasGit = spawnSync("git", ["--version"]).status === 0;
  if (!hasGit) console.log("SKIP  the git checks: git is not installed");
  else {
    // A repository made here, with the user's own hooks and signing kept out of it
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) =>
      spawnSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", repo, ...args],
        { encoding: "utf8" },
      );
    g("init", "-q");
    mkdirSync(join(repo, "car", "sub"), { recursive: true });
    writeFileSync(join(repo, "car", "car.xml"), "<params/>\n");
    writeFileSync(join(repo, "car", "sub", "tex.png"), Buffer.from([0, 1, 2, 255]));
    g("add", "-A");
    g("commit", "-q", "-m", "plain");
    const plain = g("rev-parse", "HEAD").stdout.trim();
    const out = join(tmp, "tree-ok");
    const n = writeTree(repo, plain, "car", out, "test");
    check(
      "a tree's files are written out of git byte for byte, without the prefix",
      n === 2 && readFileSync(join(out, "sub", "tex.png")).equals(Buffer.from([0, 1, 2, 255])),
      files(out).join(", "),
    );
    let linked: string | null = null;
    try {
      symlinkSync("/etc/passwd", join(repo, "car", "readme.txt"));
      g("add", "-A");
      g("commit", "-q", "-m", "a link");
      linked = g("rev-parse", "HEAD").stdout.trim();
    } catch {
      // Windows runners without symlink privilege skip the symlink refusal test
    }
    if (linked) {
      const out2 = join(tmp, "tree-link");
      const why = await refusal(() => writeTree(repo, linked, "car", out2, "test"));
      check("a tree holding a link is refused before anything is written", /is a link/.test(why) && !existsSync(out2), why);
    }
    const blob = Buffer.from("surfaces\n");
    writeFileSync(join(tmp, "blob.txt"), blob);
    const want = spawnSync("git", ["hash-object", join(tmp, "blob.txt")], {
      encoding: "utf8",
    }).stdout.trim();
    check("a file's blob id is git's own", gitBlobId(blob) === want, `${gitBlobId(blob)} ${want}`);
  }

  // --- Provenance ----------------------------------------------------------------------------------------------------------

  {
    const forged = join(tmp, "forged-circuit");
    mkdirSync(forged);
    writeFileSync(
      join(forged, SOURCE_FILE),
      JSON.stringify({
        from: "asset-database",
        license: "Free Art License",
        author: "Someone",
      }),
    );
    check("a .sd-source.json outside the cache is not believed", readSdSource(forged) === null);
  }

  // --- The cached shared data ----------------------------------------------------------------------------------------------

  const surfaces = join(SD_DATA_DIR, "data", "tracks", "surfaces.xml");
  if (!hasGit || !existsSync(surfaces))
    console.log("SKIP  the cached shared data: no speed-dreams-data in scripts/mods/.cache/speed-dreams (npm run mod -- import sd-track --fetch <circuit>)");
  else {
    const good = readFileSync(surfaces);
    writeFileSync(surfaces, Buffer.concat([good, Buffer.from("<!-- changed -->")]));
    const [again] = sdDataFiles(["data/tracks/surfaces.xml"]);
    check("a shared file changed in the cache is fetched again at the pinned commit", again === surfaces && readFileSync(surfaces).equals(good));
    check("a path outside the data folder is refused", /not a path/.test(await refusal(() => sdDataFiles(["../speed-dreams-data.git/config"]))));
  }

  // --- Downloads -----------------------------------------------------------------------------------------------------------

  check("a download over plain http is refused", /not an https link/.test(await refusal(() => download("http://example.invalid/x.zip", "test", 1))));
}

void main()
  .catch((err) => check("the fetcher could be checked", false, err instanceof Error ? (err.stack ?? err.message) : String(err)))
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll Speed Dreams fetcher checks passed.");
  });
