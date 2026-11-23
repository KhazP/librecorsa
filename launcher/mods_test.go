package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The vector from src/lib/mods/mod-manifest.ts packageHash: mod.json = `{"a":1}`, ring/track.glb = `glb-bytes`
const (
	vectorModJSON  = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
	vectorTrackGLB = "73b18949c3b005215fc7c63efc8c29d5b31ce0760ca9a2f60396cc41b12e970f"
	vectorPackage  = "0a87214af104da9524508e9dd80ac73d8479d7ce1ef462857e6bda7d202aaa4a"
)

type index struct {
	Format   int          `json:"format"`
	Packages []indexEntry `json:"packages"`
}

func readIndex(t *testing.T, s http.Handler) index {
	t.Helper()
	w := get(s, "/mods/_index.json")
	if w.Code != http.StatusOK {
		t.Fatalf("_index.json: %d", w.Code)
	}
	var idx index
	if err := json.Unmarshal(w.Body.Bytes(), &idx); err != nil {
		t.Fatal(err)
	}
	return idx
}

func TestHashPackageVector(t *testing.T) {
	got := hashPackage(map[string]string{"ring/track.glb": vectorTrackGLB, "mod.json": vectorModJSON})
	if got != vectorPackage {
		t.Errorf("hashPackage = %s, want %s", got, vectorPackage)
	}
}

func TestModsIndexVector(t *testing.T) {
	s, base := fixture(t)
	// Junk an archiver or file manager leaves is not part of the package
	writeFiles(t, filepath.Join(base, "mods", "acme.ring"), map[string]string{
		".DS_Store":           "finder",
		"ring/.DS_Store":      "finder",
		"ring/Thumbs.db":      "explorer",
		"__MACOSX/._mod.json": "fork",
	})
	idx := readIndex(t, s)
	if idx.Format != 1 || len(idx.Packages) != 1 {
		t.Fatalf("index = %+v", idx)
	}
	if p := idx.Packages[0]; p.ID != "acme.ring" || p.Hash != vectorPackage {
		t.Errorf("package = %+v, want acme.ring %s", p, vectorPackage)
	}
}

func TestModsInvalidFoldersIgnored(t *testing.T) {
	s, base := fixture(t)
	writeFiles(t, filepath.Join(base, "mods"), map[string]string{
		"Acme.Caps/mod.json":                            "{}",
		"nodot/mod.json":                                "{}",
		"acme.nomod/track.glb":                          "x",
		"acme.toolongnamexxxxxxxxxxxxxxxxxxxx/mod.json": "{}",
		"-acme.ring/mod.json":                           "{}",
		"README.txt":                                    "drop packages here",
		"acme.file":                                     "a file, not a folder",
		"acme.dirmod/mod.json/x":                        "mod.json is a folder",
	})
	idx := readIndex(t, s)
	if len(idx.Packages) != 1 || idx.Packages[0].ID != "acme.ring" {
		t.Errorf("index = %+v, want only acme.ring", idx)
	}
	for _, p := range []string{"/mods/nodot/mod.json", "/mods/Acme.Caps/mod.json", "/mods/acme.nomod/track.glb", "/mods/README.txt", "/mods/acme.ring", "/mods/acme.ring/", "/mods/acme.ring/missing.glb"} {
		if w := get(s, p); w.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", p, w.Code)
		}
	}
	if w := get(s, "/mods/acme.ring/ring/track.glb"); w.Code != http.StatusOK || w.Body.String() != "glb-bytes" {
		t.Errorf("track.glb: got %d %q", w.Code, w.Body.String())
	}
}

func TestModsHashCache(t *testing.T) {
	s, base := fixture(t)
	track := filepath.Join(base, "mods", "acme.ring", "ring", "track.glb")
	info, err := os.Stat(track)
	if err != nil {
		t.Fatal(err)
	}
	if h, _ := s.mods.packageHash("acme.ring"); h != vectorPackage {
		t.Fatalf("hash = %s", h)
	}

	// Same size and time: the kept hash is used, without reading the files
	writeFiles(t, filepath.Dir(track), map[string]string{"track.glb": "GLB-BYTES"})
	if err := os.Chtimes(track, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if h, _ := s.mods.packageHash("acme.ring"); h != vectorPackage {
		t.Errorf("cached hash = %s, want the kept %s", h, vectorPackage)
	}

	// A newer time: hashed again
	later := info.ModTime().Add(time.Minute)
	if err := os.Chtimes(track, later, later); err != nil {
		t.Fatal(err)
	}
	if h, _ := s.mods.packageHash("acme.ring"); h == vectorPackage {
		t.Error("hash unchanged after the file changed")
	}

	// A new file: hashed again
	writeFiles(t, filepath.Dir(track), map[string]string{"track.glb": "glb-bytes"})
	if h, _ := s.mods.packageHash("acme.ring"); h != vectorPackage {
		t.Errorf("hash after restoring = %s, want %s", h, vectorPackage)
	}
	writeFiles(t, filepath.Dir(track), map[string]string{"extra.json": "{}"})
	if h, _ := s.mods.packageHash("acme.ring"); h == vectorPackage {
		t.Error("hash unchanged after a file was added")
	}
	if err := os.Remove(filepath.Join(filepath.Dir(track), "extra.json")); err != nil {
		t.Fatal(err)
	}

	// The same size and an older time (a zip unpacked over it keeps the archive's times): hashed again
	modJSON := filepath.Join(base, "mods", "acme.ring", "mod.json")
	before, _ := s.mods.packageHash("acme.ring")
	writeFiles(t, filepath.Dir(modJSON), map[string]string{"mod.json": `{"b":2}`})
	earlier := info.ModTime().Add(-time.Hour)
	if err := os.Chtimes(modJSON, earlier, earlier); err != nil {
		t.Fatal(err)
	}
	if h, _ := s.mods.packageHash("acme.ring"); h == before {
		t.Error("hash unchanged after a same-size edit with an older time")
	}
}

// A folder is a package only by a mod.json of its own: one linked from another package lists nothing serveFile serves
func TestModsLinkedManifestIgnored(t *testing.T) {
	s, base := fixture(t)
	mods := filepath.Join(base, "mods")
	if err := os.MkdirAll(filepath.Join(mods, "evil.link"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(mods, "acme.ring", "mod.json"), filepath.Join(mods, "evil.link", "mod.json")); err != nil {
		t.Skip("no symbolic links here:", err)
	}
	idx := readIndex(t, s)
	if len(idx.Packages) != 1 || idx.Packages[0].ID != "acme.ring" {
		t.Errorf("index = %+v, want only acme.ring", idx)
	}
}

func TestIsSafeModPath(t *testing.T) {
	for _, p := range []string{"mod.json", "ring/track.glb", "a/b/c.ktx2"} {
		if !isSafeModPath(p) {
			t.Errorf("isSafeModPath(%q) = false", p)
		}
	}
	for _, p := range []string{"", "/mod.json", "../x", "a/../b", "./a", "a//b", "a\\b", "c:x", "a?b", "a#b", "a\x00b", "a\x7fb", string(make([]byte, 241))} {
		if isSafeModPath(p) {
			t.Errorf("isSafeModPath(%q) = true", p)
		}
	}
}

func TestIsArchiveJunk(t *testing.T) {
	for _, p := range []string{".DS_Store", "a/.DS_Store", "Thumbs.db", "a/thumbs.DB", "__MACOSX/._x", "a/__MACOSX/x"} {
		if !isArchiveJunk(p) {
			t.Errorf("isArchiveJunk(%q) = false", p)
		}
	}
	for _, p := range []string{"mod.json", "a/__MACOSXy/x", "a.DS_Store", "Thumbs.dbx"} {
		if isArchiveJunk(p) {
			t.Errorf("isArchiveJunk(%q) = true", p)
		}
	}
}

// A package's files are served only as the types a package may carry, never as something that runs on the game's
// origin, and sandboxed even then
func TestModsServeOnlyPackageFileTypes(t *testing.T) {
	s, base := fixture(t)
	writeFiles(t, filepath.Join(base, "mods", "acme.ring"), map[string]string{
		"page.html":   "<script>alert(1)</script>",
		"image.svg":   "<svg onload=alert(1)></svg>",
		"noextension": "<script>alert(1)</script>",
		"code.js":     "alert(1)",
		"notes.md":    "# notes",
	})
	for _, p := range []string{"/mods/acme.ring/page.html", "/mods/acme.ring/image.svg", "/mods/acme.ring/noextension", "/mods/acme.ring/code.js"} {
		if w := get(s, p); w.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", p, w.Code)
		}
	}
	w := get(s, "/mods/acme.ring/ring/track.glb")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "model/gltf-binary" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("track.glb: %d, type %q, CSP %q", w.Code, w.Header().Get("Content-Type"), w.Header().Get("Content-Security-Policy"))
	}
	if w := get(s, "/mods/acme.ring/notes.md"); w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/markdown") {
		t.Errorf("notes.md: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
}
