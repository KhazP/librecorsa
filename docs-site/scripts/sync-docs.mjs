// Builds the site's pages from the Markdown in ../docs, which stays the one copy: GitHub shows the same files, and
// README, CONTRIBUTING and code comments link to them there. Only the pages in ../pages.mjs are published; the rest
// of docs/ (apps.md, DESIGN.md) are maintainer notes.
//
// Each page's first `# Heading` becomes its title, links to another published page go to that page on the site,
// files a page shows or links next to it (charts, CSVs) are copied beside it, and any other repository path goes to
// GitHub. Everything written here is generated and git-ignored.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES } from "../pages.mjs";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "..");
const REPO_URL = "https://github.com/KhazP/librecorsa";

const CONTENT = join(SITE, "src/content/docs");
const PUBLIC_FILES = join(SITE, "public/files");
const BRAND = join(SITE, "src/assets/brand");

const bySource = new Map(PAGES.map((p) => [p.source, p]));
const routeOf = (slug) => (slug ? `/${slug}/` : "/");

/** Where a link written in `source` goes on the site, or null to leave it as written */
function rewrite(target, source, copied) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) return null;
  const [path, hash = ""] = target.split(/(?=#)/);
  const repoPath = posix.normalize(posix.join(posix.dirname(source), decodeURI(path)));
  if (repoPath.startsWith("..")) throw new Error(`${source}: link ${target} leaves the repository`);
  const page = bySource.get(repoPath);
  if (page) return routeOf(page.slug) + hash;
  const file = join(REPO, repoPath);
  if (!existsSync(file)) throw new Error(`${source}: link ${target} points at ${repoPath}, which does not exist`);
  // Charts and data next to a published page are served from the site; anything else lives on GitHub
  if (repoPath.startsWith("docs/") && /\.(svg|png|jpe?g|webp|gif|csv)$/i.test(repoPath)) {
    copied.add(repoPath);
    return `/files/${repoPath.slice("docs/".length)}${hash}`;
  }
  const kind = statSync(file).isDirectory() ? "tree" : "blob";
  return `${REPO_URL}/${kind}/main/${repoPath}${hash}`;
}

/** The page body with every link and image target outside code rewritten */
function rewriteLinks(body, source, copied) {
  let fenced = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      // Inline code spans keep their text; only ](target) outside them changes
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2
            ? part
            : part.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, target, title) => {
                const to = rewrite(target, source, copied);
                return to === null ? all : `](${to}${title})`;
              }),
        )
        .join("");
    })
    .join("\n");
}

/** Title from the first `# Heading` outside code, removed from the body (the site prints it), and a description */
function splitTitle(text, source) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fenced = false;
  const at = lines.findIndex((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^# /.test(line);
  });
  if (at < 0) throw new Error(`${source} has no # heading for its title`);
  const title = lines[at].slice(2).trim();
  const body = lines.slice(at + 1).join("\n").replace(/^\n+/, "");
  const firstParagraph = body.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*[#>|`!-]/.test(p)) ?? "";
  const plain = firstParagraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const description = plain.length > 160 ? `${plain.slice(0, plain.lastIndexOf(" ", 157))}...` : plain;
  return { title, body, description };
}

function main() {
  rmSync(CONTENT, { recursive: true, force: true });
  rmSync(PUBLIC_FILES, { recursive: true, force: true });
  const copied = new Set();
  for (const { source, slug } of PAGES) {
    const { title, body, description } = splitTitle(readFileSync(join(REPO, source), "utf8"), source);
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(title)}`,
      ...(description ? [`description: ${JSON.stringify(description)}`] : []),
      // Starlight titles a page "<page> | <site>", which reads "LibreCorsa docs | LibreCorsa docs" on the front page
      ...(slug ? [] : ["head:", "  - tag: title", `    content: ${JSON.stringify(title)}`]),
      `editUrl: ${JSON.stringify(`${REPO_URL}/edit/main/${source}`)}`,
      "---",
      "",
    ].join("\n");
    const out = join(CONTENT, `${slug || "index"}.md`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, frontmatter + rewriteLinks(body, source, copied));
  }
  for (const repoPath of copied) {
    const out = join(PUBLIC_FILES, repoPath.slice("docs/".length));
    mkdirSync(dirname(out), { recursive: true });
    cpSync(join(REPO, repoPath), out);
  }
  // The game's own logo and mark, so the two sites can't drift apart
  mkdirSync(BRAND, { recursive: true });
  for (const name of ["librecorsa-logo.svg", "librecorsa-logo-on-light.svg"]) {
    cpSync(join(REPO, "public/branding", name), join(BRAND, name));
  }
  cpSync(join(REPO, "public/branding/librecorsa-mark.svg"), join(SITE, "public/favicon.svg"));
  console.log(`docs: ${PAGES.length} pages, ${copied.size} files (${relative(REPO, CONTENT)})`);
}

main();
