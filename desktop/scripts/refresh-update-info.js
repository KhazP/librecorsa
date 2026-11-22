#!/usr/bin/env node
// Rebuilds an installer's .blockmap and its entry in latest.yml after the installer has been changed on disk,
// which Authenticode signing does. electron-builder computes both before SignPath signs the installer, so
// without this the auto-updater rejects the signed download (sha512 mismatch) and differential updates read
// a block map of the wrong file.
//
// Usage: node scripts/refresh-update-info.js <installer> <latest.yml>
//
// The block map comes from electron-builder's own builder (the same call NsisTarget makes for a non-web
// installer), so it matches what an unsigned build would have shipped byte for byte. That module sits under
// app-builder-lib's out/ folder, which is why electron-builder is pinned to an exact version in package.json.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { serializeToYaml } = require("builder-util");
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");

async function main() {
  const [installerArg, latestArg] = process.argv.slice(2);
  if (!installerArg || !latestArg) {
    throw new Error("usage: refresh-update-info.js <installer> <latest.yml>");
  }
  const installer = path.resolve(installerArg);
  const latestFile = path.resolve(latestArg);
  const name = path.basename(installer);

  const info = yaml.load(fs.readFileSync(latestFile, "utf8"));
  const entries = Array.isArray(info?.files) ? info.files.filter((file) => file.url === name) : [];
  if (entries.length !== 1) {
    throw new Error(`${path.basename(latestFile)} lists ${entries.length} files named ${name}, expected 1`);
  }

  const { size, sha512 } = await buildBlockMap(installer, "gzip", `${installer}.blockmap`);
  const entry = entries[0];
  const before = entry.sha512;
  entry.sha512 = sha512;
  entry.size = size;
  if (info.path === name) {
    info.sha512 = sha512;
  }

  fs.writeFileSync(latestFile, serializeToYaml(info, false, true));
  console.log(`${name}: ${size} bytes, sha512 ${before === sha512 ? "unchanged" : "updated"}; block map rebuilt`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
