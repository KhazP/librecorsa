// Builds the offline launcher (launcher/*.go) into launcher/dist/<os>-<arch>/, and with --bundle packages it as the
// LibreCorsa app for each platform, with the game's export (`out/` from `npm run build`) and the converter
// (launcher/converter/build.mjs) inside:
//
//   macOS     dist/darwin-<arch>/LibreCorsa.app   Contents/MacOS/librecorsa, Contents/Resources/{game,converter,icon.icns},
//             Info.plist (no Dock icon: the game's window is the app); signed ad hoc when built on a Mac (codesign)
//             → dist/LibreCorsa-<version>-mac-<arch>.zip, and .dmg when hdiutil is there
//   Windows   dist/windows-amd64/LibreCorsa/      LibreCorsa.exe (a window app with its icon and version), game, converter
//             → dist/LibreCorsa-<version>-win-x64.zip
//   Linux     dist/linux-amd64/LibreCorsa/        librecorsa, game, converter, librecorsa.desktop, librecorsa.png
//             → dist/LibreCorsa-<version>-linux-x64.tar.gz
//
// Each archive holds that one folder, as the launcher's self-update unpacks it (update.go; tools/release pack). The
// player's own folders aren't in it: the launcher makes them in Documents/LibreCorsa.
//
// update-key.pub, when it is there, is built in as the key updates must be signed with (npm run launcher:keygen);
// without it a build only tells the player a newer release is out.
//
// Usage: npm run launcher:build [-- --bundle] [-- --only darwin-arm64,linux-amd64] [-- --version 1.2.3]
//          [-- --no-archive]     the folders only (CI signs the Windows launcher, then packs)
//          [-- --archive-only]   pack folders built earlier
//          [-- --update-key <file>]  build in another key than update-key.pub (a test's throwaway one)
// Needs Go (launcher/go.mod names the version). The Windows icon and version are made by a pinned go-winres, fetched by
// `go run` on first use (it never enters go.mod).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(launcherDir, "..");
const distDir = join(launcherDir, "dist");
const outDir = join(repoDir, "out");
/** The app's icons: icon.icns (macOS), icon.ico (Windows), icon.png (Linux) */
const iconsDir = join(launcherDir, "icons");

/** The platforms a release is built for: the same as internal/release Targets, whose archive names tools/release checks */
const TARGETS = [
  { os: "darwin", arch: "arm64", label: "mac-arm64", format: "zip" },
  { os: "darwin", arch: "amd64", label: "mac-x64", format: "zip" },
  { os: "windows", arch: "amd64", label: "win-x64", format: "zip" },
  { os: "linux", arch: "amd64", label: "linux-x64", format: "tar.gz" },
];

/** Makes the Windows launcher's resources (icon, version, manifest): pinned, run with `go run`, so never in go.mod */
const GO_WINRES = "github.com/tc-hib/go-winres@v0.3.3";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (at < 0) return null;
  return args[at].includes("=") ? args[at].slice(name.length + 1) : (args[at + 1] ?? "");
};
const archiveOnly = args.includes("--archive-only");
const bundle = args.includes("--bundle") || archiveOnly;
const archives = bundle && !args.includes("--no-archive");
const onlyValue = flagValue("--only");
const only = onlyValue === null ? null : onlyValue.split(",").filter(Boolean);
const names = TARGETS.map((t) => `${t.os}-${t.arch}`);
const unknown = (only ?? []).filter((n) => !names.includes(n));
if (unknown.length || only?.length === 0) {
  console.error(`--only ${unknown.join(",") || "(nothing)"}: the targets are ${names.join(", ")}`);
  process.exit(1);
}
const targets = only ? TARGETS.filter((t) => only.includes(`${t.os}-${t.arch}`)) : TARGETS;

const version = flagValue("--version") || JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version;
const versionMatch = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]+)?$/.exec(version);
if (!versionMatch) {
  console.error(`--version ${version}: a version is MAJOR.MINOR.PATCH, with an optional -prerelease`);
  process.exit(1);
}
/** The version as Windows and macOS take it: numbers only */
const numericVersion = versionMatch.slice(1, 4).join(".");

if (bundle && !archiveOnly && !existsSync(join(outDir, "index.html"))) {
  console.error("out/index.html not found: run npm run build first (--bundle copies the game's export)");
  process.exit(1);
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const goTool = (argv, opts = {}) => execFileSync("go", ["run", "./tools/release", ...argv], { cwd: launcherDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

/** The update key built in: update-key.pub's keys (or --update-key's), checked by tools/release */
const updateKeys = () => {
  const file = flagValue("--update-key") || join(launcherDir, "update-key.pub");
  if (!existsSync(file)) {
    console.warn(`${relative(repoDir, file)} isn't there: this build can't update itself, only say a newer release is out (npm run launcher:keygen)`);
    return "";
  }
  return goTool(["pubkeys", resolve(file)]).trim();
};

/**
 * What of out/ a release leaves behind: Cloudflare's `_headers` (the launcher sets its own), a clone's test packages
 * (`mods/`: the player's mods folder stands in for them), source maps, and what a file manager leaves
 */
const leftOut = (rel) => {
  const parts = rel.split(/[\\/]/);
  const base = parts[parts.length - 1];
  return rel === "_headers" || parts[0] === "mods" || base.endsWith(".map") || base === ".DS_Store" || base.toLowerCase() === "thumbs.db";
};

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The macOS app's Info.plist. LSUIElement: no Dock icon or menu, since the game's window is the app. */
const infoPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>LibreCorsa</string>
  <key>CFBundleExecutable</key>
  <string>librecorsa</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundleIdentifier</key>
  <string>org.librecorsa.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>LibreCorsa</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${xml(numericVersion)}</string>
  <key>CFBundleVersion</key>
  <string>${xml(numericVersion)}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.racing-games</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>LibreCorsa keeps your mods, and the circuits and cars you convert, in Documents/LibreCorsa.</string>
  <key>NSHumanReadableCopyright</key>
  <string>LibreCorsa contributors, AGPL-3.0</string>
</dict>
</plist>
`;

/** The Linux app's .desktop entry: the launcher writes it into the app menu with the folder's own paths (desktopentry.go) */
const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=LibreCorsa
GenericName=Racing simulator
Comment=Open-source racing simulator
Exec=librecorsa
TryExec=librecorsa
Icon=librecorsa
Terminal=false
Categories=Game;Simulation;
Keywords=racing;sim;motorsport;
`;

/** Each target's folder: where its binary goes, and what is packed */
const layout = ({ os, arch }) => {
  const dir = join(distDir, `${os}-${arch}`);
  if (!bundle) return { dir, binary: join(dir, os === "windows" ? "librecorsa.exe" : "librecorsa") };
  if (os === "darwin") {
    const root = join(dir, "LibreCorsa.app");
    return { dir, root, binary: join(root, "Contents", "MacOS", "librecorsa"), resources: join(root, "Contents", "Resources") };
  }
  const root = join(dir, "LibreCorsa");
  return { dir, root, binary: join(root, os === "windows" ? "LibreCorsa.exe" : "librecorsa"), resources: root };
};

/** Writes the Windows resources (icon, version, manifest) as a .syso the Go build links in; returns it to remove after */
const windowsResources = () => {
  const four = `${numericVersion}.0`;
  const out = join(launcherDir, "rsrc");
  const argv = [
    "run", GO_WINRES, "simply", "--arch", "amd64", "--out", out, "--manifest", "gui",
    "--icon", join(iconsDir, "icon.ico"),
    "--product-name", "LibreCorsa", "--file-description", "LibreCorsa",
    "--product-version", four, "--file-version", four,
    "--copyright", "LibreCorsa contributors, AGPL-3.0", "--original-filename", "LibreCorsa.exe",
  ];
  const res = spawnSync("go", argv, { cwd: launcherDir, stdio: "inherit", env: { ...process.env, GOOS: "", GOARCH: "" } });
  const syso = `${out}_windows_amd64.syso`;
  if (res.status !== 0 || !existsSync(syso)) {
    if (bundle) throw new Error(`${GO_WINRES} failed: a release's launcher needs its icon and version`);
    console.warn(`${GO_WINRES} failed: building without the icon`);
    return null;
  }
  return syso;
};

const keys = archiveOnly ? "" : updateKeys();
const converterDir = join(distDir, "converter");
// The converter is the same for every platform (scripts, no programs): built once, copied into each
if (bundle && !archiveOnly) run(process.execPath, [join(launcherDir, "converter", "build.mjs"), "--out", converterDir]);

const pack = (t, l) => {
  const archive = join(distDir, `LibreCorsa-${version}-${t.label}.${t.format}`);
  rmSync(archive, { force: true });
  goTool(["pack", "--out", archive, l.root], { stdio: "inherit" });
  const made = [archive];
  if (t.os === "darwin" && process.platform === "darwin" && has("hdiutil")) {
    // The disk image opens on the app beside a link to Applications, to drag it there
    const dmg = archive.replace(/\.zip$/, ".dmg");
    const link = join(l.dir, "Applications");
    rmSync(dmg, { force: true });
    rmSync(link, { force: true });
    symlinkSync("/Applications", link);
    try {
      run("hdiutil", ["create", "-quiet", "-volname", "LibreCorsa", "-srcfolder", l.dir, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg]);
    } finally {
      unlinkSync(link);
    }
    made.push(dmg);
  }
  return made;
};

for (const t of targets) {
  const l = layout(t);
  if (archiveOnly) {
    if (!existsSync(l.binary)) {
      console.error(`${relative(repoDir, l.binary)} isn't there: build it first (--bundle --no-archive)`);
      process.exit(1);
    }
    for (const f of pack(t, l)) console.log(relative(repoDir, f));
    continue;
  }
  rmSync(l.dir, { recursive: true, force: true });
  mkdirSync(dirname(l.binary), { recursive: true });

  // -trimpath and -buildvcs=false: the same source builds the same binary, whichever folder or checkout it is in.
  // Windows: a window app, with no console of its own (it attaches to a command prompt's; dialog_windows.go)
  const ldflags = [`-s -w -X main.version=${version}`];
  if (keys) ldflags.push(`-X main.updatePublicKeys=${keys}`);
  if (t.os === "windows") ldflags.push("-H=windowsgui");
  const syso = t.os === "windows" ? windowsResources() : null;
  try {
    run("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags.join(" "), "-o", l.binary, "."], {
      cwd: launcherDir,
      env: { ...process.env, GOOS: t.os, GOARCH: t.arch, CGO_ENABLED: "0" },
    });
  } finally {
    if (syso) rmSync(syso, { force: true });
  }
  if (!bundle) {
    console.log(relative(repoDir, l.binary));
    continue;
  }

  cpSync(outDir, join(l.resources, "game"), { recursive: true, filter: (src) => !leftOut(relative(outDir, src)) });
  cpSync(converterDir, join(l.resources, "converter"), { recursive: true, filter: (src) => !src.split(/[\\/]/).includes("__pycache__") });
  if (t.os === "darwin") {
    cpSync(join(iconsDir, "icon.icns"), join(l.resources, "icon.icns"));
    writeFileSync(join(l.root, "Contents", "Info.plist"), infoPlist());
    writeFileSync(join(l.root, "Contents", "PkgInfo"), "APPL????");
    // Signed ad hoc: no Developer ID yet, but one signature over the whole app, so macOS sees the app as one and not
    // as changed after it was signed (launcher/README.md: the first start)
    if (process.platform === "darwin" && has("codesign")) run("codesign", ["--force", "--sign", "-", "--timestamp=none", l.root]);
    else console.warn(`${relative(repoDir, l.root)}: not signed (codesign is only on macOS)`);
  }
  if (t.os === "linux") {
    writeFileSync(join(l.root, "librecorsa.desktop"), DESKTOP_ENTRY);
    cpSync(join(iconsDir, "icon.png"), join(l.root, "librecorsa.png"));
    chmodSync(l.binary, 0o755);
  }
  const made = archives ? pack(t, l) : [];
  console.log([relative(repoDir, l.root), ...made.map((f) => relative(repoDir, f))].join("\n  → "));
}
