package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestCatalogueFolder(t *testing.T) {
	s, base := fixture(t)
	catalogue := filepath.Join(base, "mods", "_catalogue")
	writeFiles(t, catalogue, map[string]string{
		"catalogue.json":     `{"format":1,"packages":[]}`,
		"acme.ring.zip":      "PK-zip",
		"acme.ring.webp":     "RIFF",
		"other.json":         `{}`,
		"page.html":          "<script>alert(1)</script>",
		"sub/acme.ring.zip":  "PK-nested",
		"Thumbs.db":          "explorer",
		"readme.txt":         "notes",
		"acme.ring.zip.html": "<b>no</b>",
	})
	cases := []struct {
		path, body, ct string
	}{
		{"/mods/_catalogue/catalogue.json", `{"format":1,"packages":[]}`, "application/json"},
		{"/mods/_catalogue/acme.ring.zip", "PK-zip", "application/zip"},
		{"/mods/_catalogue/acme.ring.webp", "RIFF", "image/webp"},
	}
	for _, c := range cases {
		w := get(s, c.path)
		if w.Code != http.StatusOK || w.Body.String() != c.body || w.Header().Get("Content-Type") != c.ct {
			t.Errorf("%s: %d %q %q", c.path, w.Code, w.Header().Get("Content-Type"), w.Body.String())
		}
		if w.Header().Get("Content-Security-Policy") != "sandbox; default-src 'none'" || w.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: headers %v", c.path, w.Header())
		}
	}
	// Another JSON file, a page, a subfolder, anything not listed, an escape: none of it
	for _, p := range []string{
		"/mods/_catalogue/other.json",
		"/mods/_catalogue/page.html",
		"/mods/_catalogue/sub/acme.ring.zip",
		"/mods/_catalogue/readme.txt",
		"/mods/_catalogue/acme.ring.zip.html",
		"/mods/_catalogue/missing.zip",
		"/mods/_catalogue/",
		"/mods/_catalogue/..%2fsecret.txt",
		"/mods/_catalogue/%2e%2e/acme.ring/mod.json",
	} {
		if w := get(s, p); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, w.Code)
		}
	}
	// A byte range, as a browser resumes a download
	if w := get(s, "/mods/_catalogue/acme.ring.zip", "Range", "bytes=0-1"); w.Code != http.StatusPartialContent || w.Body.String() != "PK" {
		t.Errorf("range: %d %q", w.Code, w.Body.String())
	}
	// The folder is not a package: the index leaves it out
	if idx := readIndex(t, s); len(idx.Packages) != 1 || idx.Packages[0].ID != "acme.ring" {
		t.Errorf("index = %+v", idx)
	}
}

func TestCatalogueLinkOut(t *testing.T) {
	s, base := fixture(t)
	catalogue := filepath.Join(base, "mods", "_catalogue")
	if err := os.MkdirAll(catalogue, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(catalogue, "secret.zip")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if w := get(s, "/mods/_catalogue/secret.zip"); w.Code != http.StatusNotFound {
		t.Errorf("a link out of the mods folder: %d %q", w.Code, w.Body.String())
	}
}

func TestNoCatalogueFolder(t *testing.T) {
	s, _ := fixture(t)
	if w := get(s, "/mods/_catalogue/catalogue.json"); w.Code != http.StatusNotFound {
		t.Errorf("no catalogue folder: %d, want 404", w.Code)
	}
}
