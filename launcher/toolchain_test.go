package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// tarGz makes a .tar.gz of entries in order; an entry whose content starts with "->" is a symlink to the rest
func tarGz(t *testing.T, entries [][2]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	// Stored, not compressed: one test packs the test binary, and the race detector makes deflate slow
	gz, _ := gzip.NewWriterLevel(&buf, gzip.NoCompression)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e[0], Mode: 0o755, Size: int64(len(e[1])), Typeflag: tar.TypeReg}
		if target, ok := strings.CutPrefix(e[1], "->"); ok {
			hdr = &tar.Header{Name: e[0], Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: target}
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			tw.Write([]byte(e[1]))
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipOf(t *testing.T, entries [][2]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e[0])
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e[1]))
	}
	zw.Close()
	return buf.Bytes()
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// downloadServer serves files by path over TLS, and a redirect to plain http
func downloadServer(t *testing.T, files map[string][]byte) (*httptest.Server, *toolchain) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/to-http" {
			http.Redirect(w, r, "http://example.invalid/uv.tar.gz", http.StatusFound)
			return
		}
		b, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	tc := newToolchain(t.TempDir(), "darwin", "arm64")
	tc.client.Transport = srv.Client().Transport
	return srv, tc
}

func TestFetchVerified(t *testing.T) {
	good := []byte("the pinned bytes")
	evil := []byte("other bytes here") // the same length
	srv, tc := downloadServer(t, map[string][]byte{"/good": good, "/evil": evil, "/long": append(good, '!')})
	dir := t.TempDir()
	pin := func(path string) pinnedFile {
		return pinnedFile{Name: "uv", URL: srv.URL + path, SHA256: sha(good), Size: int64(len(good))}
	}

	var seen int64
	name, err := tc.fetchVerified(context.Background(), pin("/good"), dir, func(n int64) { seen = n })
	if err != nil {
		t.Fatalf("good download: %v", err)
	}
	if b, _ := os.ReadFile(name); !bytes.Equal(b, good) || seen != int64(len(good)) {
		t.Errorf("got %q, progress %d", b, seen)
	}
	os.Remove(name)

	if _, err := tc.fetchVerified(context.Background(), pin("/evil"), dir, nil); !errors.Is(err, errHashMismatch) {
		t.Errorf("bad hash: %v, want errHashMismatch", err)
	}
	if _, err := tc.fetchVerified(context.Background(), pin("/long"), dir, nil); err == nil {
		t.Error("a longer file was taken")
	}
	if _, err := tc.fetchVerified(context.Background(), pin("/missing"), dir, nil); err == nil {
		t.Error("a 404 was taken")
	}
	if _, err := tc.fetchVerified(context.Background(), pin("/to-http"), dir, nil); err == nil || !strings.Contains(err.Error(), "only https") {
		t.Errorf("a redirect to http: %v", err)
	}
	plain := pin("/good")
	plain.URL = strings.Replace(plain.URL, "https://", "http://", 1)
	if _, err := tc.fetchVerified(context.Background(), plain, dir, nil); err == nil {
		t.Error("an http URL was fetched")
	}
	// Nothing that failed is left behind
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Errorf("left in the downloads folder: %v", left)
	}
}

func TestInstallVerifiesBeforeExtracting(t *testing.T) {
	archive := tarGz(t, [][2]string{{"uv-test/uv", "#!/bin/sh\necho uv\n"}, {"uv-test/uvx", "x"}})
	srv, tc := downloadServer(t, map[string][]byte{"/uv.tar.gz": archive})
	p := pinnedFile{Name: "uv", Version: "9.9.9", URL: srv.URL + "/uv.tar.gz", SHA256: sha(archive), Size: int64(len(archive)),
		Format: "tar.gz", Member: "uv-test/uv", Program: "uv"}

	bad := p
	bad.SHA256 = sha([]byte("something else"))
	if err := tc.install(context.Background(), bad, nil); !errors.Is(err, errHashMismatch) {
		t.Fatalf("bad hash: %v", err)
	}
	if _, err := os.Stat(tc.componentDir(p)); !os.IsNotExist(err) {
		t.Error("something was extracted from a download that didn't verify")
	}

	if err := tc.install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	prog := filepath.Join(tc.componentDir(p), "uv")
	b, err := os.ReadFile(prog)
	if err != nil || !strings.Contains(string(b), "echo uv") {
		t.Fatalf("installed %q, %v", b, err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(prog); info.Mode().Perm()&0o100 == 0 {
			t.Error("not executable")
		}
	}
	// Only the program comes out
	if entries, _ := os.ReadDir(tc.componentDir(p)); len(entries) != 1 {
		t.Errorf("extracted %v", entries)
	}
	if left, _ := os.ReadDir(filepath.Join(tc.dir, "downloads")); len(left) != 0 {
		t.Errorf("the archive is left: %v", left)
	}
}

func TestExtractProgramRefusesTricks(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, b, 0o644)
		return p
	}
	pin := pinnedFile{Name: "node", Format: "tar.gz", Member: "node-v1/bin/node", Program: "bin/node"}

	// The member as a link (to a file outside) is passed over, as are entries that climb out
	tricky := write("tricky.tar.gz", tarGz(t, [][2]string{
		{"../../escape", "evil"},
		{"/abs/evil", "evil"},
		{"node-v1/bin/node", "->/etc/passwd"},
	}))
	dest := filepath.Join(dir, "out")
	if err := extractProgram(tricky, pin, dest); err == nil {
		t.Error("a link was taken for the program")
	}
	if _, err := os.Lstat(filepath.Join(dir, "escape")); err == nil {
		t.Error("an entry climbed out of the folder")
	}
	if _, err := os.Lstat(filepath.Join(dest, "bin", "node")); err == nil {
		t.Error("the link was written")
	}

	// A pinned path that climbs out is refused before anything is read
	climb := pin
	climb.Program = "../node"
	ok := write("ok.tar.gz", tarGz(t, [][2]string{{"node-v1/bin/node", "binary"}}))
	if err := extractProgram(ok, climb, dest); err == nil {
		t.Error("a pinned path out of the folder was taken")
	}
	if err := extractProgram(ok, pin, dest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "bin", "node")); string(b) != "binary" {
		t.Errorf("extracted %q", b)
	}

	// The same for a zip (Windows)
	zpin := pinnedFile{Name: "node", Format: "zip", Member: "node-v1/node.exe", Program: "node.exe"}
	z := write("n.zip", zipOf(t, [][2]string{{"../evil.exe", "evil"}, {"node-v1/node.exe", "exe"}}))
	zdest := filepath.Join(dir, "zout")
	if err := extractProgram(z, zpin, zdest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(zdest, "node.exe")); string(b) != "exe" {
		t.Errorf("zip: extracted %q", b)
	}
	if _, err := os.Lstat(filepath.Join(dir, "evil.exe")); err == nil {
		t.Error("zip: an entry climbed out")
	}
}

func TestIsSafeArchivePath(t *testing.T) {
	for _, p := range []string{"uv", "uv-x/uv", "node-v26/bin/node", "dir/"} {
		if !isSafeArchivePath(p) {
			t.Errorf("%q refused", p)
		}
	}
	for _, p := range []string{"", "/etc/passwd", "../x", "a/../../x", "a//b", `a\b`, "C:/x", "a/./b", "a\x00b"} {
		if isSafeArchivePath(p) {
			t.Errorf("%q allowed", p)
		}
	}
}

func TestPinsAreWellFormed(t *testing.T) {
	for platform, pins := range toolchainPins {
		for _, p := range []pinnedFile{pins.UV, pins.Node} {
			if !strings.HasPrefix(p.URL, "https://") || len(p.SHA256) != 64 || p.Size <= 0 || !isSafeArchivePath(p.Member) || !isSafeArchivePath(p.Program) {
				t.Errorf("%s %s: %+v", platform, p.Name, p)
			}
			if _, err := hex.DecodeString(p.SHA256); err != nil {
				t.Errorf("%s %s: sha256 %v", platform, p.Name, err)
			}
			if strings.HasPrefix(platform, "windows") != strings.HasSuffix(p.Program, ".exe") {
				t.Errorf("%s %s: program %s", platform, p.Name, p.Program)
			}
		}
		if pins.PythonApprox <= 0 {
			t.Errorf("%s: no size for what uv fetches", platform)
		}
	}
	// Every platform a release is built for (launcher/build.mjs)
	for _, platform := range []string{"darwin/arm64", "darwin/amd64", "windows/amd64", "linux/amd64"} {
		if _, ok := toolchainPins[platform]; !ok {
			t.Errorf("no pins for %s", platform)
		}
	}
}

func TestToolchainReady(t *testing.T) {
	tc := newToolchain(t.TempDir(), "darwin", "arm64")
	conv := &converterInfo{requirementsHash: "abc"}
	conv.Python.Version = "3.14"
	if tc.ready(conv) || tc.info(conv).State != "missing" || len(tc.info(conv).Downloads) != 2 {
		t.Fatal("ready before anything was downloaded")
	}
	writeFiles(t, tc.componentDir(tc.pins.UV), map[string]string{"uv": "x"})
	writeFiles(t, tc.componentDir(tc.pins.Node), map[string]string{"bin/node": "x"})
	if got := tc.info(conv).Downloads; len(got) != 0 {
		t.Errorf("would download again: %v", got)
	}
	if tc.ready(conv) {
		t.Fatal("ready before Python was fetched")
	}
	if err := tc.markReady(conv); err != nil {
		t.Fatal(err)
	}
	if !tc.ready(conv) {
		t.Fatal("not ready after setting up")
	}
	// A converter with other packages sets up again
	conv.requirementsHash = "def"
	if tc.ready(conv) {
		t.Error("ready for other packages")
	}
	if newToolchain(t.TempDir(), "linux", "riscv64").info(conv).State != "unsupported" {
		t.Error("a platform without pins isn't unsupported")
	}
}
