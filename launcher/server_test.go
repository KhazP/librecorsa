package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testPort = 47826

// secret is in a file beside the game and mods folders, which no request may read
const secret = "TOP-SECRET-OUTSIDE-THE-ROOT"

// writeFiles writes name -> content under dir
func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// fixture makes a small export, a mods folder with one package, and a secret beside them
func fixture(t *testing.T) (s *server, base string) {
	t.Helper()
	base = t.TempDir()
	game := filepath.Join(base, "game")
	mods := filepath.Join(base, "mods")
	writeFiles(t, base, map[string]string{"secret.txt": secret})
	writeFiles(t, game, map[string]string{
		"index.html":                    "<h1>home</h1>",
		"play.html":                     "<h1>play</h1>",
		"play/__next.play.txt":          "rsc-play",
		"docs/index.html":               "<h1>docs</h1>",
		"404.html":                      "<h1>lost</h1>",
		"_next/static/chunks/app.js":    "console.log(1)",
		"_next/static/media/font.woff2": "woff2",
		"build.json":                    `{"build":"x"}`,
		"offline-manifest.json":         `{"files":[]}`,
		"manifest.webmanifest":          `{}`,
		"cars/car.glb":                  "glTF",
		"tex/a.ktx2":                    "ktx2",
		"basis/basis_transcoder.wasm":   "\x00asm",
		"audio/engine.ogg":              "OggS",
		"img/hero.webp":                 "RIFF",
		"index.txt":                     "rsc-home",
		"tracks/data.json":              `{"ok":true}`,
	})
	writeFiles(t, mods, map[string]string{
		"acme.ring/mod.json":       `{"a":1}`,
		"acme.ring/ring/track.glb": "glb-bytes",
	})
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(game, "link.txt")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}
	if err := os.Symlink("../../secret.txt", filepath.Join(mods, "acme.ring", "escape.glb")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}
	s, err := newServer(game, mods, testPort)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, base
}

func get(s http.Handler, target string, header ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	for i := 0; i+1 < len(header); i += 2 {
		if header[i] == "Host" {
			r.Host = header[i+1]
		} else {
			r.Header.Set(header[i], header[i+1])
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestPrettyURLs(t *testing.T) {
	s, _ := fixture(t)
	cases := []struct{ path, body string }{
		{"/", "<h1>home</h1>"},
		{"/play", "<h1>play</h1>"},
		{"/play/", "<h1>play</h1>"},
		{"/play.html", "<h1>play</h1>"},
		{"/play/__next.play.txt", "rsc-play"},
		{"/docs", "<h1>docs</h1>"},
		{"/docs/", "<h1>docs</h1>"},
		{"/index.txt", "rsc-home"},
	}
	for _, c := range cases {
		w := get(s, c.path)
		if w.Code != http.StatusOK || w.Body.String() != c.body {
			t.Errorf("%s: got %d %q, want 200 %q", c.path, w.Code, w.Body.String(), c.body)
		}
	}
}

func TestNotFoundPage(t *testing.T) {
	s, _ := fixture(t)
	for _, p := range []string{"/nope", "/play/nope", "/_next/static/missing.js", "/cars/"} {
		w := get(s, p)
		if w.Code != http.StatusNotFound || w.Body.String() != "<h1>lost</h1>" {
			t.Errorf("%s: got %d %q, want 404 with 404.html", p, w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s: 404 Content-Type %q", p, ct)
		}
	}
}

func TestTraversalRefused(t *testing.T) {
	s, base := fixture(t)
	abs := filepath.ToSlash(filepath.Join(base, "secret.txt"))
	targets := []string{
		"/../secret.txt",
		"/%2e%2e/secret.txt",
		"/%2E%2E%2Fsecret.txt",
		"/..%2fsecret.txt",
		"/play/../../secret.txt",
		"/..\\secret.txt",
		"/%5c..%5csecret.txt",
		"//" + strings.TrimPrefix(abs, "/"),
		"/" + abs,
		"/link.txt",
		"/C:/secret.txt",
		"/mods/../secret.txt",
		"/mods/acme.ring/../../secret.txt",
		"/mods/acme.ring/%2e%2e/%2e%2e/secret.txt",
		"/mods/acme.ring/..%5c..%5csecret.txt",
		"/mods/acme.ring/escape.glb",
		"/mods/acme.ring//etc/passwd",
		"/mods/%2e%2e/secret.txt",
	}
	for _, target := range targets {
		w := get(s, target)
		if w.Code == http.StatusOK || strings.Contains(w.Body.String(), secret) {
			t.Errorf("%s: got %d %q", target, w.Code, w.Body.String())
		}
	}
}

// TestTraversalOverTheWire sends raw request lines, as a client that doesn't clean paths would, through net/http
func TestTraversalOverTheWire(t *testing.T) {
	s, _ := fixture(t)
	ts := httptest.NewUnstartedServer(s)
	ts.Start()
	defer ts.Close()
	s.port = ts.Listener.Addr().(*net.TCPAddr).Port
	for _, target := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/mods/acme.ring/../../secret.txt", "/mods/acme.ring/%2e%2e%2f%2e%2e%2fsecret.txt"} {
		conn, err := net.Dial("tcp", ts.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n\r\n", target, s.port)
		res, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		conn.Close()
		if res.StatusCode == http.StatusOK || strings.Contains(string(body), secret) {
			t.Errorf("%s: got %d %q", target, res.StatusCode, body)
		}
	}
}

func TestHostCheck(t *testing.T) {
	s, _ := fixture(t)
	allowed := []string{"127.0.0.1:47826", "localhost:47826", "LOCALHOST:47826"}
	refused := []string{"evil.example:47826", "127.0.0.1", "localhost", "127.0.0.1:1234", "0.0.0.0:47826", "[::1]:47826", ""}
	for _, host := range allowed {
		if w := get(s, "/", "Host", host); w.Code != http.StatusOK {
			t.Errorf("Host %q: got %d, want 200", host, w.Code)
		}
	}
	for _, host := range refused {
		for _, p := range []string{"/", "/mods/_index.json", "/__launcher"} {
			if w := get(s, p, "Host", host); w.Code != http.StatusForbidden {
				t.Errorf("Host %q %s: got %d, want 403", host, p, w.Code)
			}
		}
	}
}

func TestContentTypes(t *testing.T) {
	s, _ := fixture(t)
	cases := map[string]string{
		"/":                              "text/html; charset=utf-8",
		"/play":                          "text/html; charset=utf-8",
		"/cars/car.glb":                  "model/gltf-binary",
		"/tex/a.ktx2":                    "image/ktx2",
		"/basis/basis_transcoder.wasm":   "application/wasm",
		"/manifest.webmanifest":          "application/manifest+json",
		"/audio/engine.ogg":              "audio/ogg",
		"/img/hero.webp":                 "image/webp",
		"/tracks/data.json":              "application/json",
		"/index.txt":                     "text/plain; charset=utf-8",
		"/_next/static/chunks/app.js":    "text/javascript; charset=utf-8",
		"/_next/static/media/font.woff2": "font/woff2",
		"/mods/acme.ring/ring/track.glb": "model/gltf-binary",
		"/mods/_index.json":              "application/json",
		"/__launcher":                    "application/json",
	}
	for p, want := range cases {
		w := get(s, p)
		if w.Code != http.StatusOK {
			t.Errorf("%s: status %d", p, w.Code)
		}
		if got := w.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: Content-Type %q, want %q", p, got, want)
		}
		if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options %q", p, got)
		}
	}
}

func TestCacheControl(t *testing.T) {
	s, _ := fixture(t)
	cases := map[string]string{
		"/_next/static/chunks/app.js":    "public, max-age=31536000, immutable",
		"/_next/static/media/font.woff2": "public, max-age=31536000, immutable",
		"/":                              "no-cache",
		"/play":                          "no-cache",
		"/offline-manifest.json":         "no-cache",
		"/build.json":                    "no-cache",
		"/cars/car.glb":                  "no-cache",
		"/mods/_index.json":              "no-cache",
		"/mods/acme.ring/mod.json":       "no-cache",
	}
	for p, want := range cases {
		if got := get(s, p).Header().Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control %q, want %q", p, got, want)
		}
	}
}

func TestConditionalAndRange(t *testing.T) {
	s, _ := fixture(t)
	w := get(s, "/cars/car.glb")
	etag := w.Header().Get("ETag")
	if etag == "" || w.Header().Get("Last-Modified") == "" {
		t.Fatalf("no ETag/Last-Modified: %v", w.Header())
	}
	if w := get(s, "/cars/car.glb", "If-None-Match", etag); w.Code != http.StatusNotModified {
		t.Errorf("If-None-Match: got %d, want 304", w.Code)
	}
	w = get(s, "/cars/car.glb", "Range", "bytes=1-2")
	if w.Code != http.StatusPartialContent || w.Body.String() != "lT" {
		t.Errorf("Range: got %d %q, want 206 \"lT\"", w.Code, w.Body.String())
	}
}

func TestMethods(t *testing.T) {
	s, _ := fixture(t)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x"))
	r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: got %d, want 405", w.Code)
	}
	r = httptest.NewRequest(http.MethodHead, "/play", nil)
	r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("HEAD: got %d, want 200", w.Code)
	}
}

func TestIdentity(t *testing.T) {
	s, _ := fixture(t)
	w := get(s, "/__launcher")
	var id struct{ App, Version string }
	if err := json.Unmarshal(w.Body.Bytes(), &id); err != nil || id.App != identityApp || id.Version == "" {
		t.Errorf("/__launcher: %d %q", w.Code, w.Body.String())
	}

	ts := httptest.NewServer(s)
	defer ts.Close()
	s.port = ts.Listener.Addr().(*net.TCPAddr).Port
	if !isLauncher(fmt.Sprintf("http://127.0.0.1:%d", s.port)) {
		t.Error("isLauncher: false for a launcher")
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"app":"x"}`)) }))
	defer other.Close()
	if isLauncher(other.URL) {
		t.Error("isLauncher: true for another server")
	}
}

func TestSplitPath(t *testing.T) {
	ok := map[string][]string{"/": nil, "/play": {"play"}, "/play/": {"play"}, "/a/b.js": {"a", "b.js"}}
	for p, want := range ok {
		segs, _, good := splitPath(p)
		if !good || strings.Join(segs, "/") != strings.Join(want, "/") {
			t.Errorf("splitPath(%q) = %v %v", p, segs, good)
		}
	}
	for _, p := range []string{"", "play", "/..", "/a/../b", "/./a", "//a", "/a//b", "/a\\b", "/c:", "/a\x00b", "/a\nb"} {
		if _, _, good := splitPath(p); good {
			t.Errorf("splitPath(%q) accepted", p)
		}
	}
}
