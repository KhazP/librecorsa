package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSite stands in for the live site: files with ETags (Range and If-None-Match handled by http.ServeContent),
// every request recorded
type fakeSite struct {
	t   *testing.T
	srv *httptest.Server

	mu    sync.Mutex
	files map[string]fakeFile
	// status forces an answer for a path
	status map[string]int
	// handlers take over a path
	handlers map[string]http.HandlerFunc
	seen     []*http.Request
}

type fakeFile struct{ body, etag, ctype string }

func newFakeSite(t *testing.T) *fakeSite {
	t.Helper()
	f := &fakeSite{t: t, files: map[string]fakeFile{}, status: map[string]int{}, handlers: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSite) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	c := r.Clone(r.Context())
	f.seen = append(f.seen, c)
	file, ok := f.files[r.URL.Path]
	status := f.status[r.URL.Path]
	handler := f.handlers[r.URL.Path]
	f.mu.Unlock()
	switch {
	case handler != nil:
		handler(w, r)
	case status != 0:
		http.Error(w, "forced", status)
	case !ok:
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, "<h1>site 404</h1>")
	default:
		if file.etag != "" {
			w.Header().Set("ETag", file.etag)
		}
		if file.ctype == "" {
			file.ctype = contentType(r.URL.Path)
		}
		if file.ctype != "" {
			w.Header().Set("Content-Type", file.ctype)
		}
		w.Header().Set("X-File-Size", strconv.Itoa(len(file.body)))
		http.ServeContent(w, r, r.URL.Path, time.Time{}, strings.NewReader(file.body))
	}
}

func (f *fakeSite) set(p, body, etag string) {
	f.mu.Lock()
	f.files[p] = fakeFile{body: body, etag: etag}
	f.mu.Unlock()
}

func (f *fakeSite) remove(p string) {
	f.mu.Lock()
	delete(f.files, p)
	f.mu.Unlock()
}

func (f *fakeSite) force(p string, status int) {
	f.mu.Lock()
	f.status[p] = status
	f.mu.Unlock()
}

func (f *fakeSite) handle(p string, h http.HandlerFunc) {
	f.mu.Lock()
	f.handlers[p] = h
	f.mu.Unlock()
}

// requests returns the requests seen for a path ("" for all)
func (f *fakeSite) requests(p string) []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*http.Request
	for _, r := range f.seen {
		if p == "" || r.URL.Path == p {
			out = append(out, r)
		}
	}
	return out
}

// mirrorFixture is fixture's server (its export is the seed) mirroring site, with a cache in the fixture's folder
func mirrorFixture(t *testing.T, site *fakeSite) (s *server, cacheDir string) {
	t.Helper()
	s, base := fixture(t)
	cacheDir = filepath.Join(base, "cache")
	newRun(t, s, cacheDir, site.srv.URL, false)
	return s, cacheDir
}

// newRun gives s a fresh mirror over the same cache folder, as a new launcher run would have
func newRun(t *testing.T, s *server, cacheDir, site string, offline bool) *mirror {
	t.Helper()
	if s.site != nil && s.site.cache != nil {
		s.site.cache.Close()
	}
	cache, err := openSiteCache(cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	m, err := newMirror(site, cache, offline)
	if err != nil {
		t.Fatal(err)
	}
	m.notify = func(msg string) { t.Log(msg) }
	s.enableSite(m)
	t.Cleanup(func() { cache.Close() })
	return m
}

func expect(t *testing.T, w *httptest.ResponseRecorder, what string, code int, body string) {
	t.Helper()
	if w.Code != code || w.Body.String() != body {
		t.Fatalf("%s: got %d %q, want %d %q", what, w.Code, w.Body.String(), code, body)
	}
}

func kept(cacheDir, name string) bool {
	_, err1 := os.Stat(filepath.Join(cacheDir, "files", filepath.FromSlash(name)))
	_, err2 := os.Stat(filepath.Join(cacheDir, "meta", filepath.FromSlash(name)+".json"))
	return err1 == nil && err2 == nil
}

func TestMirrorKeepsAndChecksOncePerRun(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring-v1", `"v1"`)
	s, cacheDir := mirrorFixture(t, site)
	const p = "/tracks/ring/track.glb"

	w := get(s, p)
	expect(t, w, "first", 200, "ring-v1")
	if w.Header().Get("ETag") != `"v1"` || w.Header().Get("X-File-Size") != "7" || w.Header().Get("Content-Type") != "model/gltf-binary" {
		t.Errorf("first: headers %v", w.Header())
	}
	if !kept(cacheDir, "tracks/ring/track.glb") {
		t.Fatal("not kept")
	}
	// Checked once this run: served from the cache, the browser's own revalidation too
	expect(t, get(s, p), "again", 200, "ring-v1")
	if w := get(s, p, "If-None-Match", `"v1"`); w.Code != http.StatusNotModified {
		t.Errorf("browser revalidation: got %d, want 304", w.Code)
	}
	if n := len(site.requests(p)); n != 1 {
		t.Fatalf("site asked %d times in one run, want 1", n)
	}

	// A new run asks once, with the kept copy's ETag, and a 304 serves the copy
	newRun(t, s, cacheDir, site.srv.URL, false)
	w = get(s, p)
	expect(t, w, "new run", 200, "ring-v1")
	if w.Header().Get("X-File-Size") != "7" || w.Header().Get("Content-Length") != "7" {
		t.Errorf("kept copy: headers %v", w.Header())
	}
	get(s, p)
	reqs := site.requests(p)
	if len(reqs) != 2 || reqs[1].Header.Get("If-None-Match") != `"v1"` {
		t.Fatalf("new run: %d requests, If-None-Match %q", len(reqs), reqs[len(reqs)-1].Header.Get("If-None-Match"))
	}

	// A new version under the same name replaces the kept copy
	site.set(p, "ring-v2!", `"v2"`)
	newRun(t, s, cacheDir, site.srv.URL, false)
	expect(t, get(s, p), "new version", 200, "ring-v2!")
	newRun(t, s, cacheDir, site.srv.URL, true)
	w = get(s, p)
	expect(t, w, "offline after the new version", 200, "ring-v2!")
	if w.Header().Get("ETag") != `"v2"` {
		t.Errorf("kept ETag %q, want \"v2\"", w.Header().Get("ETag"))
	}
}

func TestMirrorPagesCheckedEveryRequest(t *testing.T) {
	site := newFakeSite(t)
	site.set("/play", "<h1>live play</h1>", `"p1"`)
	site.set("/build.json", `{"build":"live"}`, `"b1"`)
	site.set("/play/__next.play.txt", "rsc-live", `"r1"`)
	site.set("/tracks/ring/track.glb", "glb", `"g1"`)
	s, cacheDir := mirrorFixture(t, site)
	for range 3 {
		expect(t, get(s, "/play"), "/play", 200, "<h1>live play</h1>")
		expect(t, get(s, "/build.json"), "/build.json", 200, `{"build":"live"}`)
		expect(t, get(s, "/play/__next.play.txt"), "payload", 200, "rsc-live")
		// A navigation is a page whatever its name
		expect(t, get(s, "/tracks/ring/track.glb", "Sec-Fetch-Mode", "navigate"), "navigation", 200, "glb")
	}
	for _, p := range []string{"/play", "/build.json", "/play/__next.play.txt", "/tracks/ring/track.glb"} {
		reqs := site.requests(p)
		if len(reqs) != 3 || reqs[2].Header.Get("If-None-Match") == "" {
			t.Errorf("%s: %d requests (want 3, the last conditional)", p, len(reqs))
		}
	}
	if !kept(cacheDir, "play.html") || !kept(cacheDir, "play/__next.play.txt") {
		t.Error("the page and its payload are not kept side by side")
	}
	// Offline, the kept page; the seed for the one never seen online
	newRun(t, s, cacheDir, site.srv.URL, true)
	expect(t, get(s, "/play"), "offline /play", 200, "<h1>live play</h1>")
	expect(t, get(s, "/"), "offline /", 200, "<h1>home</h1>")
}

func TestMirrorImmutableNeverChecked(t *testing.T) {
	site := newFakeSite(t)
	const p = "/_next/static/chunks/live-abc.js"
	site.set(p, "live()", `"c1"`)
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, p), "first", 200, "live()")
	w := get(s, p)
	expect(t, w, "again", 200, "live()")
	if w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control %q", w.Header().Get("Cache-Control"))
	}
	newRun(t, s, cacheDir, site.srv.URL, false)
	expect(t, get(s, p), "new run", 200, "live()")
	if n := len(site.requests(p)); n != 1 {
		t.Errorf("site asked %d times, want 1", n)
	}
}

// failingTransport is a network that is down, counting the tries
type failingTransport struct {
	mu    sync.Mutex
	tries int
}

func (f *failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.tries++
	f.mu.Unlock()
	return nil, errors.New("network is unreachable")
}

func (f *failingTransport) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tries
}

func TestMirrorOfflineFallback(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring-v1", `"v1"`)
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, "/tracks/ring/track.glb"), "online", 200, "ring-v1")

	m := newRun(t, s, cacheDir, site.srv.URL, false)
	down := &failingTransport{}
	m.client.Transport = down
	clock := time.Now()
	m.now = func() time.Time { return clock }

	expect(t, get(s, "/tracks/ring/track.glb"), "kept", 200, "ring-v1")
	// After the network error the site isn't asked for downFor: the seed, else the export's 404 page
	expect(t, get(s, "/cars/car.glb"), "seed", 200, "glTF")
	expect(t, get(s, "/play"), "seed page", 200, "<h1>play</h1>")
	expect(t, get(s, "/tracks/missing.glb"), "missing", 404, "<h1>lost</h1>")
	if n := down.count(); n != 1 {
		t.Fatalf("site tried %d times while down, want 1", n)
	}
	clock = clock.Add(upstreamDownFor + time.Second)
	expect(t, get(s, "/cars/car.glb"), "seed later", 200, "glTF")
	if n := down.count(); n != 2 {
		t.Fatalf("site tried %d times after downFor, want 2", n)
	}
}

func TestMirrorOfflineFlag(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring-v1", `"v1"`)
	site.set("/api/config", `{"rooms":true}`, "")
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, "/tracks/ring/track.glb"), "online", 200, "ring-v1")
	before := len(site.requests(""))

	newRun(t, s, cacheDir, site.srv.URL, true)
	expect(t, get(s, "/tracks/ring/track.glb"), "kept", 200, "ring-v1")
	expect(t, get(s, "/cars/car.glb"), "seed", 200, "glTF")
	expect(t, get(s, "/tracks/missing.glb"), "missing", 404, "<h1>lost</h1>")
	if w := get(s, "/api/config"); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), `"ok":false`) {
		t.Errorf("/api offline: got %d %q", w.Code, w.Body.String())
	}
	if n := len(site.requests("")); n != before {
		t.Errorf("--offline asked the site %d times", n-before)
	}
}

func TestMirrorTimeoutServesKept(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring-v1", `"v1"`)
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, "/tracks/ring/track.glb"), "online", 200, "ring-v1")

	site.handle("/tracks/ring/track.glb", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(5 * time.Second):
		case <-r.Context().Done():
		}
	})
	m := newRun(t, s, cacheDir, site.srv.URL, false)
	m.client.Transport.(*http.Transport).ResponseHeaderTimeout = 100 * time.Millisecond
	start := time.Now()
	expect(t, get(s, "/tracks/ring/track.glb"), "slow site", 200, "ring-v1")
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v", d)
	}
	if !m.isDown() {
		t.Error("a site that doesn't answer is not taken as down")
	}
}

func TestMirrorServerErrors(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring-v1", `"v1"`)
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, "/tracks/ring/track.glb"), "online", 200, "ring-v1")

	m := newRun(t, s, cacheDir, site.srv.URL, false)
	for _, p := range []string{"/tracks/ring/track.glb", "/cars/car.glb", "/tracks/missing.glb"} {
		site.force(p, http.StatusServiceUnavailable)
	}
	expect(t, get(s, "/tracks/ring/track.glb"), "kept", 200, "ring-v1")
	expect(t, get(s, "/cars/car.glb"), "seed", 200, "glTF")
	expect(t, get(s, "/tracks/missing.glb"), "neither", 404, "<h1>lost</h1>")
	// A 5xx is an answer: the site is asked again
	if m.isDown() {
		t.Error("a 5xx took the site as down")
	}
	get(s, "/cars/car.glb")
	if n := len(site.requests("/cars/car.glb")); n != 2 {
		t.Errorf("site asked %d times, want 2", n)
	}
	if !kept(cacheDir, "tracks/ring/track.glb") {
		t.Error("a 5xx dropped the kept copy")
	}
}

func TestMirrorNotFoundDrops(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/old/track.glb", "old", `"o1"`)
	s, cacheDir := mirrorFixture(t, site)
	expect(t, get(s, "/tracks/old/track.glb"), "online", 200, "old")
	if !kept(cacheDir, "tracks/old/track.glb") {
		t.Fatal("not kept")
	}
	site.remove("/tracks/old/track.glb")
	newRun(t, s, cacheDir, site.srv.URL, false)
	w := get(s, "/tracks/old/track.glb")
	expect(t, w, "gone", 404, "<h1>site 404</h1>")
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("404 Cache-Control %q", w.Header().Get("Cache-Control"))
	}
	for _, name := range []string{"files/tracks/old/track.glb", "meta/tracks/old/track.glb.json"} {
		if _, err := os.Stat(filepath.Join(cacheDir, filepath.FromSlash(name))); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still there (%v)", name, err)
		}
	}
	newRun(t, s, cacheDir, site.srv.URL, true)
	expect(t, get(s, "/tracks/old/track.glb"), "offline after the drop", 404, "<h1>lost</h1>")
}

// liveServer serves s over a real connection, and returns a client that sends the launcher's Host
func liveServer(t *testing.T, s *server) (base string, do func(*http.Request) (*http.Response, error)) {
	t.Helper()
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	client := ts.Client()
	return ts.URL, func(r *http.Request) (*http.Response, error) {
		r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
		return client.Do(r)
	}
}

func TestMirrorStreamsWhileKeeping(t *testing.T) {
	site := newFakeSite(t)
	half := strings.Repeat("a", 64<<10)
	release := make(chan struct{})
	site.handle("/cars/big/model.glb", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "model/gltf-binary")
		w.Header().Set("ETag", `"big1"`)
		w.Header().Set("Content-Length", strconv.Itoa(2*len(half)))
		w.Header().Set("X-File-Size", strconv.Itoa(2*len(half)))
		io.WriteString(w, half)
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, half)
	})
	s, cacheDir := mirrorFixture(t, site)
	base, do := liveServer(t, s)

	req, _ := http.NewRequest(http.MethodGet, base+"/cars/big/model.glb", nil)
	res, err := do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Length") != strconv.Itoa(2*len(half)) || res.Header.Get("X-File-Size") != strconv.Itoa(2*len(half)) {
		t.Errorf("headers %v", res.Header)
	}
	// The first half reaches the browser while the site still holds the second
	first := make([]byte, len(half))
	if _, err := io.ReadFull(res.Body, first); err != nil {
		t.Fatal(err)
	}
	if kept(cacheDir, "cars/big/model.glb") {
		t.Fatal("kept before it was whole")
	}
	close(release)
	rest, err := io.ReadAll(res.Body)
	if err != nil || len(rest) != len(half) {
		t.Fatalf("rest: %d bytes, %v", len(rest), err)
	}
	waitFor(t, "the whole file kept", func() bool { return kept(cacheDir, "cars/big/model.glb") })
	newRun(t, s, cacheDir, site.srv.URL, true)
	w := get(s, "/cars/big/model.glb")
	if w.Code != 200 || w.Body.Len() != 2*len(half) || w.Header().Get("X-File-Size") != strconv.Itoa(2*len(half)) {
		t.Errorf("kept copy: %d, %d bytes, %v", w.Code, w.Body.Len(), w.Header())
	}
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for range 200 {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestMirrorCutDownloadNotKept(t *testing.T) {
	site := newFakeSite(t)
	cut := func(withLength bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("ETag", `"cut"`)
			if withLength {
				w.Header().Set("Content-Length", "100000")
			}
			io.WriteString(w, strings.Repeat("x", 50000))
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}
	}
	site.handle("/cars/cut/sized.glb", cut(true))
	site.handle("/cars/cut/chunked.glb", cut(false))
	s, cacheDir := mirrorFixture(t, site)
	base, do := liveServer(t, s)
	for _, p := range []string{"/cars/cut/sized.glb", "/cars/cut/chunked.glb"} {
		req, _ := http.NewRequest(http.MethodGet, base+p, nil)
		res, err := do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.ReadAll(res.Body)
		res.Body.Close()
		if err == nil {
			t.Errorf("%s: the browser took a cut download for a whole file", p)
		}
		if kept(cacheDir, strings.TrimPrefix(p, "/")) {
			t.Errorf("%s: a cut download was kept", p)
		}
	}
	waitFor(t, "tmp/ emptied", func() bool {
		entries, _ := os.ReadDir(filepath.Join(cacheDir, "tmp"))
		return len(entries) == 0
	})
}

func TestMirrorRanges(t *testing.T) {
	site := newFakeSite(t)
	site.set("/audio/engine.ogg", "abcdefgh", `"e1"`)
	s, cacheDir := mirrorFixture(t, site)

	// Not kept: the Range goes to the site as it is, and nothing is kept
	w := get(s, "/audio/engine.ogg", "Range", "bytes=2-5")
	expect(t, w, "range from the site", http.StatusPartialContent, "cdef")
	if w.Header().Get("Content-Range") != "bytes 2-5/8" {
		t.Errorf("Content-Range %q", w.Header().Get("Content-Range"))
	}
	if reqs := site.requests("/audio/engine.ogg"); len(reqs) != 1 || reqs[0].Header.Get("Range") != "bytes=2-5" {
		t.Fatalf("site saw %d requests", len(reqs))
	}
	if kept(cacheDir, "audio/engine.ogg") {
		t.Fatal("a part of a file was kept")
	}
	// Kept: ranges come from the copy
	expect(t, get(s, "/audio/engine.ogg"), "whole", 200, "abcdefgh")
	if !kept(cacheDir, "audio/engine.ogg") {
		t.Fatal("the whole file not kept")
	}
	w = get(s, "/audio/engine.ogg", "Range", "bytes=4-")
	expect(t, w, "range from the cache", http.StatusPartialContent, "efgh")
	if n := len(site.requests("/audio/engine.ogg")); n != 2 {
		t.Errorf("site asked %d times, want 2", n)
	}

	// A media element asks for a whole file as bytes=0-: it is downloaded whole, answered as a 206 of all of it, and kept
	site.set("/music/air.mp3", "0123456789", `"m1"`)
	w = get(s, "/music/air.mp3", "Range", "bytes=0-")
	expect(t, w, "bytes=0-", http.StatusPartialContent, "0123456789")
	if w.Header().Get("Content-Range") != "bytes 0-9/10" || w.Header().Get("Accept-Ranges") != "bytes" {
		t.Errorf("bytes=0-: headers %v", w.Header())
	}
	if reqs := site.requests("/music/air.mp3"); len(reqs) != 1 || reqs[0].Header.Get("Range") != "" {
		t.Errorf("bytes=0-: the site was asked for a part")
	}
	if !kept(cacheDir, "music/air.mp3") {
		t.Error("bytes=0-: not kept")
	}
	newRun(t, s, cacheDir, site.srv.URL, true)
	expect(t, get(s, "/music/air.mp3", "Range", "bytes=0-"), "offline bytes=0-", http.StatusPartialContent, "0123456789")
}

func TestMirrorHeadAndRedirects(t *testing.T) {
	site := newFakeSite(t)
	site.set("/cars/gt3/cockpit.glb", "cockpit", `"k1"`)
	site.handle("/docs", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, site.srv.URL+"/docs/", http.StatusPermanentRedirect)
	})
	s, cacheDir := mirrorFixture(t, site)

	r := httptest.NewRequest(http.MethodHead, "/cars/gt3/cockpit.glb", nil)
	r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "7" {
		t.Errorf("HEAD: %d %v", w.Code, w.Header())
	}
	if reqs := site.requests("/cars/gt3/cockpit.glb"); len(reqs) != 1 || reqs[0].Method != http.MethodHead {
		t.Error("HEAD not passed on")
	}
	if kept(cacheDir, "cars/gt3/cockpit.glb") {
		t.Error("a HEAD kept something")
	}

	w = get(s, "/docs")
	if w.Code != http.StatusPermanentRedirect || w.Header().Get("Location") != "/docs/" {
		t.Errorf("redirect: %d to %q", w.Code, w.Header().Get("Location"))
	}
}

// Names that differ only in case are different files on the site; on a folder that ignores case they find each
// other's copy, which the record's path turns away
func TestMirrorCaseOfNames(t *testing.T) {
	site := newFakeSite(t)
	site.set("/cars/Model.glb", "upper", `"u"`)
	site.set("/cars/model.glb", "lower", `"l"`)
	s, _ := mirrorFixture(t, site)
	expect(t, get(s, "/cars/Model.glb"), "upper", 200, "upper")
	expect(t, get(s, "/cars/model.glb"), "lower", 200, "lower")
	expect(t, get(s, "/cars/Model.glb"), "upper again", 200, "upper")
}

func TestMirrorLocalPathsNeverAsked(t *testing.T) {
	site := newFakeSite(t)
	s, _ := mirrorFixture(t, site)
	for _, p := range []string{"/mods/_index.json", "/mods/acme.ring/mod.json", "/mods/acme.ring/nope.glb", "/mods", "/mods/",
		"/__launcher", "/__launcher/open?code=x", "/__launcher/imports", "/__launcherx", "/__launcher/whatever.js"} {
		get(s, p)
	}
	expect(t, get(s, "/mods/acme.ring/mod.json"), "mod", 200, `{"a":1}`)
	if n := len(site.requests("")); n != 0 {
		t.Errorf("site asked %d times for local paths (%s)", n, site.requests("")[0].URL)
	}
}

func TestMirrorHostCheck(t *testing.T) {
	site := newFakeSite(t)
	site.set("/tracks/ring/track.glb", "ring", `"r"`)
	s, _ := mirrorFixture(t, site)
	for _, p := range []string{"/tracks/ring/track.glb", "/api/config", "/play"} {
		if w := get(s, p, "Host", "evil.example:47826"); w.Code != http.StatusForbidden {
			t.Errorf("%s with another Host: got %d, want 403", p, w.Code)
		}
	}
	if n := len(site.requests("")); n != 0 {
		t.Errorf("site asked %d times for another Host", n)
	}
}

func TestMirrorUnsafePaths(t *testing.T) {
	site := newFakeSite(t)
	s, _ := mirrorFixture(t, site)
	for _, p := range []string{"/a/../secret.txt", "/a//b.glb", "/a\\b.glb", "/c:/x.glb"} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.URL.Path = p
		r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("%q: got %d, want 404", p, w.Code)
		}
	}
	if n := len(site.requests("")); n != 0 {
		t.Errorf("site asked %d times for unsafe paths", n)
	}
}

func TestCacheName(t *testing.T) {
	cases := map[string]string{
		"/":                      "index.html",
		"/play":                  "play.html",
		"/play/":                 "play/index.html",
		"/play.html":             "play.html",
		"/play/__next.play.txt":  "play/__next.play.txt",
		"/tracks/ring/track.glb": "tracks/ring/track.glb",
		"/docs/setup":            "docs/setup.html",
	}
	for p, want := range cases {
		segs, trailing, ok := splitPath(p)
		if !ok {
			t.Fatalf("%s refused", p)
		}
		if got := cacheName(segs, trailing); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
}

func TestResolveSite(t *testing.T) {
	cases := []struct {
		value        string
		given, clone bool
		want         string
		bad          bool
	}{
		{"", false, false, defaultSite, false},
		{"", false, true, "", false},
		{"https://staging.example.org", true, true, "https://staging.example.org", false},
		{"https://LibreCorsa.org/", true, false, "https://librecorsa.org", false},
		{"http://127.0.0.1:8787", true, false, "http://127.0.0.1:8787", false},
		{"", true, false, "", false},
		{"librecorsa.org", true, false, "", true},
		{"ftp://librecorsa.org", true, false, "", true},
		{"https://librecorsa.org/play", true, false, "", true},
		{"https://user@librecorsa.org", true, false, "", true},
	}
	for _, c := range cases {
		got, err := resolveSite(c.value, c.given, c.clone)
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("resolveSite(%q, %v, %v) = %q, %v", c.value, c.given, c.clone, got, err)
		}
	}
}

// A stale record (a crash between the file's rename and its record's) is never served with the file
func TestCacheRecordMustMatch(t *testing.T) {
	dir := t.TempDir()
	c, err := openSiteCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	write := func(body string) {
		f, name, err := c.create()
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(f, body)
		f.Close()
		if err := c.commit(name, "a/b.glb", keptMeta{ETag: `"x"`}); err != nil {
			t.Fatal(err)
		}
	}
	write("one")
	if k := c.open("a/b.glb"); k == nil || k.meta.ETag != `"x"` || k.meta.Size != 3 {
		t.Fatal("not kept")
	} else {
		k.f.Close()
	}
	// Another body under the old record
	if err := os.WriteFile(filepath.Join(dir, "files", "a", "b.glb"), []byte("other!"), 0o600); err != nil {
		t.Fatal(err)
	}
	if k := c.open("a/b.glb"); k != nil {
		k.f.Close()
		t.Fatal("a file served under another file's record")
	}
	// tmp/ is emptied when the cache opens
	os.WriteFile(filepath.Join(dir, "tmp", "left-over"), []byte("x"), 0o600)
	c2, err := openSiteCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	c2.Close()
	if entries, _ := os.ReadDir(filepath.Join(dir, "tmp")); len(entries) != 0 {
		t.Error("tmp/ not emptied")
	}
}

func TestNoSiteServesTheExportOnly(t *testing.T) {
	s, _ := fixture(t)
	expect(t, get(s, "/api/config"), "/api without a site", 404, "<h1>lost</h1>")
	expect(t, get(s, "/cars/car.glb"), "export", 200, "glTF")
}
