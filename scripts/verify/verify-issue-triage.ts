/**
 * Automated GitHub issue triage rules (`.github/scripts/issue_triage.mjs`):
 * verifies piracy/reupload sites, direct file hosts, commercial 3D stores, game-rip creators,
 * missing links/permissions, and low-effort bug reports against real issue fixtures.
 *
 *   npx tsx scripts/verify/verify-issue-triage.ts
 */
import { triageIssue } from "../../.github/scripts/issue_triage.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
}

// #256 — assettoworld.com + ACC + blank license
const r256 = triageIssue({
  title: "[Track request] Bathurst Mount Panorama",
  labels: ["content-request"],
  body: `### Car or track?\n\nTrack\n\n### What would you like?\n\nBathurst Mount Panorama\n\n### Model link\n\nhttps://www.assettoworld.com/track/bathurst-mount-panorama\n\n### Creator / modder\n\nACC\n\n### License\n\n_No response_\n\n### Permission to use it\n\nThe license allows it`,
});
check("Piracy site (assettoworld.com) auto-closes as not_planned", r256.action === "close" && r256.reason === "piracy" && r256.closeReason === "not_planned", JSON.stringify(r256.reason));

// #216 — assettolab.ru
const r216 = triageIssue({
  title: "[Car request] Genesis GMR-001",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://assettolab.ru/car/genesis-gmr-001-lmh-2/\n\n### Creator / modder\n\nVencialo\n\n### License\n\nOther license\n\n### Permission to use it\n\nThe license allows it`,
});
check("Piracy site (assettolab.ru) auto-closes", r216.action === "close" && r216.reason === "piracy", r216.reason);

// #243 — assettocorsa.club + Not asked yet
const r243 = triageIssue({
  title: "[Track request] Singapore",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://assettocorsa.club/mods/tracks/marina-bay-street-circuit.html\n\n### Creator / modder\n\n_No response_\n\n### License\n\nCC0 / public domain\n\n### Permission to use it\n\nNot asked yet`,
});
check("Reupload site (assettocorsa.club) auto-closes", r243.action === "close" && r243.reason === "piracy", r243.reason);

// Direct file host
const rMega = triageIssue({
  title: "[Car request] Porsche 963",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://mega.nz/file/abcdef123\n\n### Creator / modder\n\nSomeModder\n\n### License\n\nCC BY / CC BY-SA\n\n### Permission to use it\n\nThe license allows it`,
});
check("Direct file host (mega.nz) auto-closes", rMega.action === "close" && rMega.reason === "file-host", rMega.reason);

// Commercial 3D store
const rStore = triageIssue({
  title: "[Car request] Ferrari 296",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://www.turbosquid.com/3d-models/ferrari-123\n\n### Creator / modder\n\nStudio3D\n\n### License\n\nOther license\n\n### Permission to use it\n\nThe license allows it`,
});
check("Commercial 3D store auto-closes", rStore.action === "close" && rStore.reason === "commercial-store", rStore.reason);

// Commercial game as creator on otherwise unknown domain
const rGameCreator = triageIssue({
  title: "[Track request] Spa",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://example.com/spa-track\n\n### Creator / modder\n\nACC\n\n### License\n\nCC BY / CC BY-SA\n\n### Permission to use it\n\nThe license allows it`,
});
check("Commercial game listed as creator auto-closes", rGameCreator.action === "close" && rGameCreator.reason === "blocked-creator", rGameCreator.reason);

// Missing permission / Not asked yet on legit OverTake link
const rNoPerm = triageIssue({
  title: "[Track request] Grobnik",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://www.overtake.gg/downloads/automotodrom-grobnik.4835/\n\n### Creator / modder\n\nModAuthor\n\n### License\n\nCC0 / public domain\n\n### Permission to use it\n\nNot asked yet`,
});
check("OverTake request with 'Not asked yet' auto-closes", rNoPerm.action === "close" && rNoPerm.reason === "needs-permission", rNoPerm.reason);

// Valid OverTake request with written permission & proof stays open
const rValidOvertake = triageIssue({
  title: "[Track request] Grobnik",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://www.overtake.gg/downloads/automotodrom-grobnik.4835/\n\n### Creator / modder\n\nModAuthor\n\n### License\n\nOther license\n\n### Permission to use it\n\nThe creator gave written permission\n\n### Anything else?\n\nAuthor replied yes here: https://www.overtake.gg/threads/12345/`,
});
check("Valid OverTake request with written permission stays open", rValidOvertake.action === "ok", rValidOvertake.reason);

// Valid CC BY request stays open
const rValidCC = triageIssue({
  title: "[Track request] Demo Track",
  labels: ["content-request"],
  body: `### Model link\n\nhttps://sketchfab.com/3d-models/demo-0b1085d93dfa4e81aab2c83c26bf185b\n\n### Creator / modder\n\nMapper\n\n### License\n\nCC BY / CC BY-SA\n\n### Permission to use it\n\nThe license allows it`,
});
check("Valid CC BY request stays open", rValidCC.action === "ok", rValidCC.reason);

// #254 — low-effort bug steps ("i dont knwo")
const r254 = triageIssue({
  title: "[Bug] almost every track pit lane is broken",
  labels: ["bug"],
  body: `### What happened?\n\nalmost every track pit lane is broken either i sink in or blocked\n\n### Steps to reproduce\n\ni dont knwo`,
});
check("Low-effort bug steps ('i dont knwo') flagged needs-more-info", r254.action === "needs_more_info" && r254.addLabels.includes("needs-more-info"), r254.action);

// #226 — steps copied verbatim from What happened
const r226 = triageIssue({
  title: "[Bug] Critical issue all lap times in leaderboard missing from all tracks",
  labels: ["bug"],
  body: `### What happened?\n\nCritical issue all lap times in leaderboard missing from all tracks\n\n### Steps to reproduce\n\nCritical issue all lap times in leaderboard missing from all tracks`,
});
check("Bug with copy-pasted steps flagged needs-more-info", r226.action === "needs_more_info", r226.action);

// Good bug report passes
const rGoodBug = triageIssue({
  title: "[Bug] Car falls through floor in Chang pit lane",
  labels: ["bug"],
  body: `### What happened?\n\nDriving into the left pit boxes at Chang drops the car through the floor and respawns it on track.\n\n### Steps to reproduce\n\n1. Load Chang International Circuit GP in LC25\n2. Enter pit lane and steer left into box 1`,
});
check("Detailed bug report stays clean", rGoodBug.action === "ok", rGoodBug.reason);

// Maintainer issues are always untouched
const rOwner = triageIssue({
  title: "Announcement for Roadmap",
  labels: ["bug", "content-request"],
  authorAssociation: "OWNER",
  body: "Short post",
});
check("Maintainer issues are exempt", rOwner.action === "ok" && rOwner.reason === "maintainer", rOwner.reason);

console.log(failed ? `\n${failed} issue triage check(s) failed.` : "\nAll issue triage checks passed.");
if (failed) process.exit(1);
