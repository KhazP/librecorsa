package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestXDGDocumentsDir(t *testing.T) {
	cases := map[string]string{
		"XDG_DOCUMENTS_DIR=\"$HOME/Documents\"\n": "/home/p/Documents",
		"# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOCUMENTS_DIR=\"$HOME/Dokumente\"\n": "/home/p/Dokumente",
		"XDG_DOCUMENTS_DIR=\"/data/docs\"\n":            "/data/docs",
		"XDG_DOCUMENTS_DIR=\"$HOME/My \\\"Docs\\\"\"\n": "/home/p/My \"Docs\"",
		"  XDG_DOCUMENTS_DIR=\"$HOME/Docs\"  \n":        "/home/p/Docs",
		// Switched off, or written in a way the spec doesn't allow: the default
		"XDG_DOCUMENTS_DIR=\"$HOME\"\n":        "",
		"XDG_DOCUMENTS_DIR=\"$HOME/\"\n":       "",
		"XDG_DOCUMENTS_DIR=$HOME/Documents\n":  "",
		"XDG_DOCUMENTS_DIR=\"relative/x\"\n":   "",
		"XDG_DOCUMENTS_DIR=\"${HOME}/x\"\n":    "",
		"XDG_DOWNLOAD_DIR=\"$HOME/Downloads\"": "",
		"":                                     "",
	}
	for in, want := range cases {
		got := filepath.ToSlash(xdgDocumentsDir(strings.NewReader(in), "/home/p"))
		if got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestAppBundle(t *testing.T) {
	cases := map[string]string{
		"/Applications/LibreCorsa.app/Contents/MacOS":   "/Applications/LibreCorsa.app",
		"/Users/p/Apps/LibreCorsa 2.app/Contents/MacOS": "/Users/p/Apps/LibreCorsa 2.app",
		"/Users/p/LibreCorsa":                           "",
		"/Users/p/Contents/MacOS":                       "",
		"/x/LibreCorsa.app/Contents/Resources":          "",
		"":                                              "",
	}
	for in, want := range cases {
		if got := filepath.ToSlash(appBundleOf(filepath.FromSlash(in))); got != want {
			t.Errorf("appBundleOf(%q) = %q, want %q", in, got, want)
		}
	}
	if got := resourcesFor("/opt/LibreCorsa"); got != "/opt/LibreCorsa" {
		t.Errorf("resourcesFor outside an app: %s", got)
	}
}

func TestPlayerFolders(t *testing.T) {
	flagDir := t.TempDir()
	if got, _ := playerFolder(flagDir, "mods", "../public/mods", true); got != flagDir {
		t.Errorf("the flag: %s", got)
	}
	got, _ := playerFolder("", "mods", filepath.Join("..", "public", "mods"), true)
	if want, _ := filepath.Abs(filepath.Join("..", "public", "mods")); got != want {
		t.Errorf("a clone: %s", got)
	}
	got, _ = playerFolder("", "import", "import", false)
	if filepath.Base(got) != "import" || filepath.Base(filepath.Dir(got)) != "LibreCorsa" {
		t.Errorf("a release: %s", got)
	}
}

func TestMakeModsDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Documents", "LibreCorsa", "mods")
	if err := makeModsDir(dir); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "README.txt"))
	if err != nil || !strings.Contains(string(b), "mod.json") {
		t.Errorf("README: %v", err)
	}
	// One the player removed isn't written again into a folder that is there
	os.Remove(filepath.Join(dir, "README.txt"))
	if err := makeModsDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "README.txt")); err == nil {
		t.Error("the README came back")
	}
}

func TestMirrorConverter(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, map[string]string{"converter.json": `{"format":1}`, "scripts/mods/mod-tool.mjs": "// tool"})
	os.Chmod(filepath.Join(src, "scripts", "mods", "mod-tool.mjs"), 0o755)
	if runtime.GOOS != "windows" {
		os.Symlink("/etc/passwd", filepath.Join(src, "link"))
	}
	dst := filepath.Join(t.TempDir(), "converter")
	if err := mirrorConverter(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "scripts", "mods", "mod-tool.mjs")); err != nil || string(b) != "// tool" {
		t.Errorf("copied %q %v", b, err)
	}
	if _, err := os.Lstat(filepath.Join(dst, "link")); err == nil {
		t.Error("a link was copied")
	}
	// The same converter isn't copied again; a working copy made in it stays until another comes
	os.MkdirAll(filepath.Join(dst, "public", "tracks", "work"), 0o755)
	if err := mirrorConverter(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "public", "tracks", "work")); err != nil {
		t.Error("copied again")
	}
	writeFiles(t, src, map[string]string{"converter.json": `{"format":1,"version":"2"}`})
	if err := mirrorConverter(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "converter.json")); !strings.Contains(string(b), `"2"`) {
		t.Error("a new converter wasn't copied")
	}
}

func TestDropFinderArgs(t *testing.T) {
	got := dropFinderArgs([]string{"/Applications/LibreCorsa.app/Contents/MacOS/librecorsa", "-psn_0_12345", "--port", "1"})
	if strings.Join(got, " ") != "/Applications/LibreCorsa.app/Contents/MacOS/librecorsa --port 1" {
		t.Errorf("%v", got)
	}
}
