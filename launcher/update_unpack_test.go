package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// archiveEntry is one entry of a test archive: a file (content), a folder (dir), or a link (link, hard for a hard
// link)
type archiveEntry struct {
	name    string
	content string
	mode    int64
	dir     bool
	link    string
	hard    bool
}

func tarOf(t *testing.T, entries []archiveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: e.mode, Typeflag: tar.TypeReg, Size: int64(len(e.content))}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		switch {
		case e.dir:
			h.Typeflag, h.Size = tar.TypeDir, 0
		case e.link != "" && e.hard:
			h.Typeflag, h.Size, h.Linkname = tar.TypeLink, 0, e.link
		case e.link != "":
			h.Typeflag, h.Size, h.Linkname = tar.TypeSymlink, 0, e.link
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte(e.content))
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipEntries(t *testing.T, entries []archiveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name}
		mode := fs.FileMode(e.mode)
		if mode == 0 {
			mode = 0o644
		}
		switch {
		case e.dir:
			mode |= fs.ModeDir
		case e.link != "":
			mode = fs.ModeSymlink | 0o777
			e.content = e.link
		}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.content))
	}
	zw.Close()
	return buf.Bytes()
}

// unpackBytes unpacks an archive's bytes into a new folder, and returns it
func unpackBytes(t *testing.T, data []byte, format string) (string, error) {
	t.Helper()
	base := t.TempDir()
	archive := filepath.Join(base, "archive")
	if err := os.WriteFile(archive, data, 0o600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(base, "out")
	return dest, unpackUpdate(archive, format, "LibreCorsa", dest)
}

func TestUnpackUpdate(t *testing.T) {
	entries := []archiveEntry{
		{name: "LibreCorsa/", dir: true},
		{name: "LibreCorsa/librecorsa", content: "program", mode: 0o755},
		{name: "LibreCorsa/game/index.html", content: "<h1>game</h1>"},
		{name: "LibreCorsa/game/_next/static/a.js", content: "js"},
	}
	for format, data := range map[string][]byte{"tar.gz": tarOf(t, entries), "zip": zipEntries(t, entries)} {
		dest, err := unpackBytes(t, data, format)
		if err != nil {
			t.Fatalf("%s: %v", format, err)
		}
		b, err := os.ReadFile(filepath.Join(dest, "LibreCorsa", "game", "_next", "static", "a.js"))
		if err != nil || string(b) != "js" {
			t.Errorf("%s: %q %v", format, b, err)
		}
		if runtime.GOOS != "windows" {
			info, _ := os.Stat(filepath.Join(dest, "LibreCorsa", "librecorsa"))
			page, _ := os.Stat(filepath.Join(dest, "LibreCorsa", "game", "index.html"))
			if info.Mode().Perm()&0o111 == 0 || page.Mode().Perm()&0o111 != 0 {
				t.Errorf("%s: the program is %v, a page %v", format, info.Mode(), page.Mode())
			}
		}
	}
}

func TestUnpackUpdateRefusesUnsafeEntries(t *testing.T) {
	good := archiveEntry{name: "LibreCorsa/game/index.html", content: "x"}
	cases := map[string][]archiveEntry{
		"a parent folder":        {good, {name: "../evil", content: "x"}},
		"a parent inside":        {good, {name: "LibreCorsa/../../evil", content: "x"}},
		"an absolute name":       {good, {name: "/tmp/evil", content: "x"}},
		"a backslash":            {good, {name: `LibreCorsa\..\..\evil`, content: "x"}},
		"a drive letter":         {good, {name: "C:/evil", content: "x"}},
		"outside the folder":     {good, {name: "Other/evil", content: "x"}},
		"beside the folder":      {good, {name: "LibreCorsaX/evil", content: "x"}},
		"a dot segment":          {good, {name: "LibreCorsa/./game/x", content: "x"}},
		"an empty segment":       {good, {name: "LibreCorsa//x", content: "x"}},
		"a control character":    {good, {name: "LibreCorsa/a\x01b", content: "x"}},
		"a symbolic link":        {good, {name: "LibreCorsa/game/link", link: "/etc/passwd"}},
		"a relative link":        {good, {name: "LibreCorsa/game/link", link: "../../../../etc/passwd"}},
		"a name twice":           {good, good},
		"a file then its folder": {good, {name: "LibreCorsa/game/index.html/x", content: "x"}},
		"nothing in the folder":  {{name: "Other/", dir: true}},
	}
	for name, entries := range cases {
		formats := map[string][]byte{"tar.gz": tarOf(t, entries)}
		formats["zip"] = zipEntries(t, entries)
		for format, data := range formats {
			dest, err := unpackBytes(t, data, format)
			if err == nil {
				t.Errorf("%s (%s): unpacked", name, format)
			}
			// Nothing outside the destination
			if _, err := os.Lstat(filepath.Join(filepath.Dir(dest), "evil")); err == nil {
				t.Errorf("%s (%s): wrote outside", name, format)
			}
		}
	}
	// A hard link (tar only)
	data := tarOf(t, []archiveEntry{good, {name: "LibreCorsa/game/hard", link: "LibreCorsa/game/index.html", hard: true}})
	if _, err := unpackBytes(t, data, "tar.gz"); !errors.Is(err, errUnsafeArchive) {
		t.Errorf("a hard link: %v", err)
	}
	// An unknown format
	if _, err := unpackBytes(t, []byte("x"), "rar"); err == nil {
		t.Error("an unknown format was unpacked")
	}
}

func TestUnpackUpdateDoesNotFollowALinkAlreadyThere(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	// The destination must be new: a folder already there (with a link in it) is refused
	base := t.TempDir()
	dest := filepath.Join(base, "out")
	os.MkdirAll(dest, 0o755)
	os.Symlink(base, filepath.Join(dest, "LibreCorsa"))
	archive := filepath.Join(base, "a.tar.gz")
	os.WriteFile(archive, tarOf(t, []archiveEntry{{name: "LibreCorsa/evil", content: "x"}}), 0o600)
	if err := unpackUpdate(archive, "tar.gz", "LibreCorsa", dest); err == nil {
		t.Error("unpacked into a folder that was there")
	}
	if _, err := os.Lstat(filepath.Join(base, "evil")); err == nil {
		t.Error("wrote through the link")
	}
}
