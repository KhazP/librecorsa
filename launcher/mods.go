package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf16"
)

// packageIDPattern is a package's id, as src/lib/mods/mod-manifest.ts PACKAGE_ID checks it (`<author>.<name>`)
var packageIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,15}\.[a-z0-9][a-z0-9_-]{0,23}$`)

// modsFolder serves the packages a player dropped beside the launcher: one folder per package, named by its id and
// holding a mod.json, and the list the game reads them from (`/mods/_index.json`, src/lib/mods/mod-loader.ts)
type modsFolder struct {
	root *os.Root

	mu     sync.Mutex
	hashes map[string]cachedHash
}

// treeStamp sums up a package's files cheaply (no reads): when it is unchanged, so is the package's hash
type treeStamp struct {
	newest int64
	files  int
	bytes  int64
}

type cachedHash struct {
	stamp treeStamp
	hash  string
}

func openModsFolder(dir string) (*modsFolder, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &modsFolder{root: root, hashes: map[string]cachedHash{}}, nil
}

func (m *modsFolder) Close() error { return m.root.Close() }

// packageIDs lists the folders that are packages: named by a valid id and holding a mod.json. Anything else in the
// folder (a README, a zip, a folder named otherwise) is left alone.
func (m *modsFolder) packageIDs() ([]string, error) {
	dir, err := m.root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if !packageIDPattern.MatchString(e.Name()) {
			continue
		}
		if info, err := m.root.Stat(e.Name() + "/mod.json"); err == nil && info.Mode().IsRegular() {
			ids = append(ids, e.Name())
		}
	}
	slices.Sort(ids)
	return ids, nil
}

type indexEntry struct {
	ID   string `json:"id"`
	Hash string `json:"hash,omitempty"`
}

// serveIndex answers `/mods/_index.json`, made from the folder as it is now: `{ "format": 1, "packages": [{ "id",
// "hash" }] }`. A package whose files can't all be read is listed without a hash.
func (m *modsFolder) serveIndex(w http.ResponseWriter, r *http.Request) {
	ids, err := m.packageIDs()
	if err != nil {
		log.Printf("mods: %v", err)
	}
	packages := make([]indexEntry, 0, len(ids))
	for _, id := range ids {
		hash, err := m.packageHash(id)
		if err != nil {
			log.Printf("mods: %s: %v", id, err)
		}
		packages = append(packages, indexEntry{ID: id, Hash: hash})
	}
	body, _ := json.Marshal(map[string]any{"format": 1, "packages": packages})
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-cache")
	w.Write(body)
}

// serveFile answers `/mods/<packageId>/<path>` from that package's folder, which nothing in the request can leave
func (m *modsFolder) serveFile(w http.ResponseWriter, r *http.Request, rest string) {
	id, rel, ok := strings.Cut(rest, "/")
	if !ok || !packageIDPattern.MatchString(id) || !isSafeModPath(rel) {
		http.NotFound(w, r)
		return
	}
	pkg, err := m.root.OpenRoot(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer pkg.Close()
	if info, err := pkg.Stat("mod.json"); err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	f, err := pkg.Open(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	// A modder edits files in place, so the browser asks again each time
	w.Header().Set("Cache-Control", "no-cache")
	serveFile(w, r, f, info, rel)
}

// isSafeModPath is src/lib/mods/mod-manifest.ts isSafeModPath: relative, forward slashes, no `.`/`..` or empty
// segment, no scheme, query, fragment or control character
func isSafeModPath(p string) bool {
	if p == "" || len(p) > 240 || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\:?#") {
		return false
	}
	if strings.ContainsFunc(p, func(r rune) bool { return r < 0x20 || r == 0x7f || unicode.IsControl(r) }) {
		return false
	}
	for seg := range strings.SplitSeq(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// isArchiveJunk is src/lib/mods/zip-reader.ts isArchiveJunk: what an archiver or a file manager adds that no package
// means to carry, left out of a package's hash
func isArchiveJunk(p string) bool {
	base := path.Base(p)
	return strings.HasPrefix(p, "__MACOSX/") || base == ".DS_Store" || strings.EqualFold(base, "Thumbs.db")
}

// packageHash is a package's content hash, computed like src/lib/mods/mod-manifest.ts packageHash, and kept while the
// folder's files keep their count, sizes and times
func (m *modsFolder) packageHash(id string) (string, error) {
	pkg, err := m.root.OpenRoot(id)
	if err != nil {
		return "", err
	}
	defer pkg.Close()
	files, stamp, err := listPackage(pkg)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	cached, ok := m.hashes[id]
	m.mu.Unlock()
	if ok && cached.stamp == stamp {
		return cached.hash, nil
	}
	fileHashes := make(map[string]string, len(files))
	for _, name := range files {
		sum, err := hashFile(pkg, name)
		if err != nil {
			return "", err
		}
		fileHashes[name] = sum
	}
	hash := hashPackage(fileHashes)
	m.mu.Lock()
	m.hashes[id] = cachedHash{stamp: stamp, hash: hash}
	m.mu.Unlock()
	return hash, nil
}

// listPackage lists a package's files (forward-slash paths relative to its folder, junk left out) and stamps the tree
// with its newest time (folders' too, so a rename or a removal shows), file count and size. A symbolic link counts
// when it leads to a file inside the package.
func listPackage(pkg *os.Root) ([]string, treeStamp, error) {
	var files []string
	var stamp treeStamp
	fsys := pkg.FS()
	note := func(info fs.FileInfo) {
		stamp.newest = max(stamp.newest, info.ModTime().UnixNano())
	}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p == "__MACOSX" {
				return fs.SkipDir
			}
			if info, err := d.Info(); err == nil {
				note(info)
			}
			return nil
		}
		if isArchiveJunk(p) {
			return nil
		}
		info, err := fs.Stat(fsys, p)
		if err != nil {
			if d.Type()&fs.ModeSymlink != 0 {
				// A link that leads out of the package (or nowhere) can't be served, so it isn't part of it
				return nil
			}
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			if linkInfo, err := d.Info(); err == nil {
				note(linkInfo)
			}
		}
		note(info)
		stamp.files++
		stamp.bytes += info.Size()
		files = append(files, p)
		return nil
	})
	return files, stamp, err
}

func hashFile(pkg *os.Root, name string) (string, error) {
	f, err := pkg.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", errors.Join(errors.New(name), err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// hashPackage is the SHA-256 (hex) of `<path>\t<file sha256 hex>\n` for each file, sorted by path as JavaScript's
// default sort orders strings (by UTF-16 code unit)
func hashPackage(fileHashes map[string]string) string {
	paths := make([]string, 0, len(fileHashes))
	for p := range fileHashes {
		paths = append(paths, p)
	}
	slices.SortFunc(paths, compareUTF16)
	h := sha256.New()
	for _, p := range paths {
		io.WriteString(h, p+"\t"+fileHashes[p]+"\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func compareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
