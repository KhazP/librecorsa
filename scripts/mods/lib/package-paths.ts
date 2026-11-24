/**
 * The paths the packagers write to and copy from, checked before anything is written or deleted: ids as mod.json
 * takes them and paths a package may use (the game's own rules, src/lib/mods/mod-manifest.ts), every target inside the
 * package folder and every source a plain file, with no symbolic link on the way to either. A converter's output or a
 * spec file (`from-car`) names these paths, so none is trusted.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSafeModPath, modContentId, parseModContentId } from "../../../src/lib/mods/mod-manifest";

/** Whether `child` is inside `parent`, and not `parent` itself */
export function isInside(parent: string, child: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return r !== "" && !isAbsolute(r) && r.split(sep)[0] !== "..";
}

/** A package-local id (a circuit's, a car's, a livery's) as mod.json takes it, or an error naming `what` */
export function assertLocalId(id: unknown, what: string): string {
  if (typeof id !== "string" || !parseModContentId(modContentId("tool.check", id))) {
    throw new Error(`${what}: ${JSON.stringify(id)} is not an id a package may use (a-z, 0-9, - and _, at most 16, starting with a letter or digit)`);
  }
  return id;
}

/** A symbolic link at `path` (which may not exist) */
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Where `rel` goes in the package at `packageDir`: a path a package may use, inside the folder, with no symbolic link
 * among the folders and file already there (a link would send the write, or a delete, elsewhere)
 */
export function packageTarget(packageDir: string, rel: string, what: string): string {
  if (!isSafeModPath(rel)) throw new Error(`${what}: ${JSON.stringify(rel)} is not a path a package may use`);
  const root = resolve(packageDir);
  const target = resolve(root, rel);
  if (!isInside(root, target)) throw new Error(`${what}: ${rel} is outside the package`);
  if (isLink(root)) throw new Error(`${packageDir}: the package folder is a symbolic link`);
  let at = root;
  for (const part of rel.split("/")) {
    at = join(at, part);
    if (isLink(at)) throw new Error(`${what}: ${relative(root, at)} in the package is a symbolic link`);
  }
  return target;
}

/** A file to copy into a package: a plain file, not a link, and (with `root`) one whose real path is inside `root` */
export function sourceFile(path: string, what: string, root?: string): string {
  if (!existsSync(path) && !isLink(path)) throw new Error(`${what}: ${path} doesn't exist`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${what}: ${path} is a symbolic link, which is never copied into a package`);
  if (!st.isFile()) throw new Error(`${what}: ${path} is not a file`);
  if (root && !isInside(realpathSync(root), realpathSync(path))) throw new Error(`${what}: ${path} is outside ${root}`);
  return path;
}
