/**
 * Automated GitHub Issue triage logic for `.github/workflows/issue-triage.yml`.
 * Shares the exact domain, creator, and low-effort rules with the in-game Feedback panel
 * (`src/lib/feedback/request-rules.json`).
 */
import { readFileSync } from "node:fs";

const rules = JSON.parse(
  readFileSync(new URL("../../src/lib/feedback/request-rules.json", import.meta.url), "utf8")
);

const OPEN_LICENSES = [
  "cc by / cc by-sa",
  "cc0 / public domain",
  "cc by-nc / cc by-nc-sa",
  "cc by",
  "cc by-sa",
  "cc0",
  "public domain",
  "cc by-nc",
  "cc by-nc-sa",
  "mit",
  "apache",
  "gpl",
  "agpl",
];

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const normalizePhrase = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .replace(/^[.,!?;:\-–—"'()[\]]+|[.,!?;:\-–—"'()[\]]+$/g, "")
    .trim();

const BLOCKED_CREATOR_SET = new Set(rules.blockedCreators.map(normalizePhrase));
const LOW_EFFORT_SET = new Set(rules.lowEffortExact.map(normalizePhrase));

const matchesDomain = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

/** Parse GitHub issue-form Markdown (`### Heading\n\nValue`) into a lowercase-keyed map */
export function parseIssueSections(body) {
  const sections = new Map();
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const matches = [...text.matchAll(/^###\s+(.+?)\s*$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].trim().toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const raw = text.slice(start, end).trim();
    sections.set(key, raw === "_No response_" ? "" : raw);
  }
  return sections;
}

/** Extract all http(s) URLs from arbitrary text */
export function extractUrls(text) {
  const found = String(text ?? "").match(/https?:\/\/[^\s<>)"'`]+/gi) ?? [];
  return found.map((u) => u.replace(/[.,;:!?)]+$/, ""));
}

export function classifyUrl(raw) {
  let host = "";
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "invalid", host: "" };
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { kind: "invalid", host: "" };
  }
  if (!host.includes(".")) return { kind: "invalid", host: "" };
  if (matchesDomain(host, rules.piracyDomains)) return { kind: "piracy", host };
  if (matchesDomain(host, rules.fileHostDomains)) return { kind: "file-host", host };
  if (matchesDomain(host, rules.commercialStoreDomains)) return { kind: "commercial-store", host };
  return { kind: "ok", host };
}

function isLowEffortField(raw, minChars, compareTo) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length < minChars) return true;
  const norm = normalizePhrase(trimmed);
  if (!norm || LOW_EFFORT_SET.has(norm)) return true;
  if (/^(.)\1+$/.test(norm.replace(/\s+/g, ""))) return true;
  if (compareTo && normalizePhrase(compareTo) === norm) return true;
  return false;
}

function isOpenLicenseText(license) {
  const norm = normalizePhrase(license);
  if (!norm || norm === "don't know" || norm === "dont know" || norm === "other license" || norm === "other") {
    return false;
  }
  return OPEN_LICENSES.some((open) => norm === open || norm.startsWith(`${open} `) || norm.includes("creative commons"));
}

const OFFLINE_MOD_NOTE =
  "*(In the meantime, the LibreCorsa desktop app lets you import unencrypted Assetto Corsa mods locally for offline hotlapping.)*";

/**
 * Evaluate a GitHub issue and decide whether to auto-close, label `needs-more-info`, or leave open.
 * @param {{ title?: string; body?: string; labels?: string[]; authorAssociation?: string }} input
 * @returns {{ action: "ok" | "close" | "needs_more_info"; reason: string; addLabels: string[]; closeReason?: string; comment?: string; marker?: string }}
 */
export function triageIssue({ title = "", body = "", labels = [], authorAssociation = "" }) {
  if (MAINTAINER_ASSOCIATIONS.has(String(authorAssociation).toUpperCase())) {
    return { action: "ok", reason: "maintainer", addLabels: [] };
  }

  const labelSet = new Set(labels.map((l) => String(l).toLowerCase()));
  const sections = parseIssueSections(body);
  const titleLower = String(title).trim().toLowerCase();

  const isContentRequest =
    labelSet.has("content-request") ||
    /^\[(car|track)?\s*request\]/i.test(titleLower) ||
    sections.has("model link") ||
    sections.has("car or track?");

  const isWheelReport = /^\[wheel\]/i.test(titleLower) || sections.has("wheel base and rim");
  const isLapReport = /^\[lap issue\]/i.test(titleLower) || sections.has("what looks wrong");
  const isRightsRequest = labelSet.has("rights-request") || /^\[rights\]/i.test(titleLower);

  if (isRightsRequest || isLapReport) {
    return { action: "ok", reason: "exempt", addLabels: [] };
  }

  // 1. Content-request rules (piracy/reupload sites, file hosts, commercial stores, game rips, missing permission/link)
  if (isContentRequest) {
    const modelLinkSection = sections.get("model link") ?? "";
    const creator = sections.get("creator / modder") ?? "";
    const license = sections.get("license") ?? "";
    const permission = sections.get("permission to use it") ?? "";
    const notes = sections.get("anything else?") ?? "";

    const linkUrls = extractUrls(modelLinkSection);
    const allUrls = extractUrls(body);

    // 1a. Piracy / reupload site anywhere in the request
    for (const url of [...linkUrls, ...allUrls]) {
      const verdict = classifyUrl(url);
      if (verdict.kind === "piracy") {
        const marker = "<!-- librecorsa-triage:piracy -->";
        return {
          action: "close",
          reason: "piracy",
          closeReason: "not_planned",
          addLabels: ["invalid-source"],
          marker,
          comment: [
            marker,
            "Thanks for the request!",
            "",
            `\`${verdict.host}\` is a mod reupload site (not the original creator's page), so LibreCorsa can't host or redistribute content from it. Everything shipped in LibreCorsa must either carry an open Creative Commons / CC0 license or have explicit written permission from the original modder.`,
            "",
            "Closing this one for now until you get permission from the original modder. If you contact the creator (for example on OverTake, Patreon, or a modding Discord) and they agree, comment here with a link to their original page and their reply so we can reopen it.",
            "",
            OFFLINE_MOD_NOTE,
          ].join("\n"),
        };
      }
    }

    // 1b. Direct file host or commercial 3D storefront in Model link
    for (const url of linkUrls) {
      const verdict = classifyUrl(url);
      if (verdict.kind === "file-host") {
        const marker = "<!-- librecorsa-triage:file-host -->";
        return {
          action: "close",
          reason: "file-host",
          closeReason: "not_planned",
          addLabels: ["invalid-source"],
          marker,
          comment: [
            marker,
            "Thanks for the request!",
            "",
            `\`${verdict.host}\` is a direct file host and doesn't verify who made the model or what license it is under. Please link the **original creator's page** instead.`,
            "",
            "Closing this one for now until you have the original creator's page and their permission (or an open license) to share it.",
            "",
            OFFLINE_MOD_NOTE,
          ].join("\n"),
        };
      }
      if (verdict.kind === "commercial-store") {
        const marker = "<!-- librecorsa-triage:commercial-store -->";
        return {
          action: "close",
          reason: "commercial-store",
          closeReason: "not_planned",
          addLabels: ["invalid-source"],
          marker,
          comment: [
            marker,
            "Thanks for the request!",
            "",
            `\`${verdict.host}\` sells commercial 3D assets whose licenses don't permit open redistribution in LibreCorsa.`,
            "",
            "Closing this one for now. If you find an openly licensed model or an original sim modder who grants written permission, feel free to open a new request with their page and reply.",
          ].join("\n"),
        };
      }
    }

    // 1c. Commercial game / studio / placeholder listed as creator
    const normCreator = normalizePhrase(creator);
    if (normCreator && BLOCKED_CREATOR_SET.has(normCreator)) {
      const marker = "<!-- librecorsa-triage:blocked-creator -->";
      return {
        action: "close",
        reason: "blocked-creator",
        closeReason: "not_planned",
        addLabels: ["invalid-source"],
        marker,
        comment: [
          marker,
          "Thanks for the request!",
          "",
          `\`${creator.trim()}\` isn't an eligible independent modder—models ripped from commercial games or with an unknown creator can't be hosted or redistributed in LibreCorsa.`,
          "",
          "Closing this one for now until you get permission from an original creator/modder. Comment here with their original page and written reply if you do!",
          "",
          OFFLINE_MOD_NOTE,
        ].join("\n"),
      };
    }

    // 1d. Missing model URL
    if (linkUrls.length === 0) {
      const marker = "<!-- librecorsa-triage:missing-link -->";
      return {
        action: "close",
        reason: "missing-link",
        closeReason: "not_planned",
        addLabels: ["needs-permission"],
        marker,
        comment: [
          marker,
          "Thanks for the request!",
          "",
          "Car and track requests need a link to an eligible 3D model on the original creator's page—requests without a model can't be built.",
          "",
          "Closing this one for now until you find an openly licensed model or get permission from an original modder and link it here.",
        ].join("\n"),
      };
    }

    // 1e. Missing / unpermitted license or permission
    const permNorm = normalizePhrase(permission);
    const saidNotAsked =
      !permNorm ||
      permNorm.includes("not asked") ||
      permNorm.includes("don't know") ||
      permNorm.includes("dont know") ||
      permNorm === "no";
    const saidLicenseAllows = permNorm.includes("license allows");
    const saidWritten = permNorm.includes("written permission");
    const invalidLicenseClaim = saidLicenseAllows && !isOpenLicenseText(license);
    const missingWrittenProof = saidWritten && isLowEffortField(notes, rules.limits.proofMin);

    if (saidNotAsked || invalidLicenseClaim || missingWrittenProof || (!saidLicenseAllows && !saidWritten)) {
      const detail = invalidLicenseClaim
        ? `You selected **"The license allows it"**, but the license field (\`${license || "empty"}\`) doesn't list an open Creative Commons / CC0 license.`
        : missingWrittenProof
          ? `You selected **"The creator gave written permission"**, but there is no link or quote of the creator's reply in **Anything else?**.`
          : `LibreCorsa can only add cars and tracks that either carry an open Creative Commons / CC0 license or have **explicit written permission from the original modder**.`;
      const marker = "<!-- librecorsa-triage:needs-permission -->";
      return {
        action: "close",
        reason: "needs-permission",
        closeReason: "not_planned",
        addLabels: ["needs-permission"],
        marker,
        comment: [
          marker,
          "Thanks for the request!",
          "",
          detail,
          "",
          "Closing this one for now until you get permission from the modder (or confirm an open Creative Commons / CC0 license). Once the creator says yes, comment here with their reply and link so we can reopen it!",
          "",
          OFFLINE_MOD_NOTE,
        ].join("\n"),
      };
    }

    return { action: "ok", reason: "valid-content-request", addLabels: [] };
  }

  // 2. Low-effort bug report check (non-destructive: labels `needs-more-info` & prompts; stale job closes if unanswered)
  const isBug = labelSet.has("bug") || /^\[bug\]/i.test(titleLower) || sections.has("what happened?");
  if (isBug && !isWheelReport) {
    const what = sections.get("what happened?") ?? "";
    const steps = sections.get("steps to reproduce") ?? "";
    const cleanTitle = String(title).replace(/^\[bug\]\s*/i, "").trim();
    const missing = [];

    if (sections.has("what happened?")) {
      if (isLowEffortField(what, rules.limits.bugWhatMin)) {
        missing.push("**What happened?** — please describe what went wrong and what you expected in a full sentence.");
      }
    } else if (isLowEffortField(body, rules.limits.bugWhatMin)) {
      missing.push("**Description** — please describe what broke and what you expected instead.");
    }

    if (sections.has("steps to reproduce")) {
      const stepsBad =
        isLowEffortField(steps, rules.limits.bugStepsMin, what) ||
        (cleanTitle.length >= 6 && normalizePhrase(steps) === normalizePhrase(cleanTitle));
      if (stepsBad) {
        missing.push("**Steps to reproduce** — please list the concrete steps we can follow to reproduce this (which circuit, car, and actions).");
      }
    }

    if (missing.length > 0) {
      const marker = "<!-- librecorsa-triage:needs-more-info -->";
      return {
        action: "needs_more_info",
        reason: "low-effort-bug",
        addLabels: ["needs-more-info"],
        marker,
        comment: [
          marker,
          "Thanks for reporting! We need a bit more detail before we can investigate this:",
          "",
          ...missing.map((m) => `- ${m}`),
          "",
          "Please edit the issue above or reply with those details—once added, the `needs-more-info` label will be cleared automatically. Issues left without reproduction details are closed after 10 days.",
        ].join("\n"),
      };
    }
  }

  return { action: "ok", reason: "ok", addLabels: [] };
}
