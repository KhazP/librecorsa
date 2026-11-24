package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The site mirror. With an upstream (--site; https://librecorsa.org in a release), every page and file outside
// /mods/ and /__launcher comes from the live site, as the website would serve it, and is kept on disk: online
// the game is the live one, hosted cars and circuits included (they live in the site's R2 bucket, not in the export),
// and offline it is what was kept, else the export bundled with the launcher (the seed), else the export's 404 page.
//
// How often the site is asked:
//   - Next's hashed build output (/_next/static/) never changes under its name: a kept copy is served without asking;
//   - pages and the files that say which build is current (navigations, .html, Next's .txt payloads,
//     offline-manifest.json, build.json, sw.js, manifest.webmanifest) are asked about on every request, with the kept
//     copy's validators (a 304 serves the copy);
//   - everything else (models, textures, sounds, track data, which keep their names when they change) is asked about
//     once per path per launcher run, like public/sw.js does for hosted files.
//
// A download is streamed to the browser while it is written to a temporary file, renamed into place once whole, so a
// cut download never leaves a broken copy. A 404 from the site drops the kept copy. A 5xx, a network error or no answer
// within upstreamHeaderTimeout serves the kept copy (else the seed); after a network error the site is taken as
// offline for upstreamDownFor, so offline play doesn't wait on every request.

// defaultSite is the upstream a release mirrors
const defaultSite = "https://librecorsa.org"

const (
	// upstreamHeaderTimeout is how long the site has to start answering (a body then takes what it takes)
	upstreamHeaderTimeout = 6 * time.Second
	// upstreamDownFor is how long the site is taken as offline after a network error
	upstreamDownFor = 30 * time.Second
)

// mirror is the site's side of the server: the upstream, the disk cache and what this run has checked
type mirror struct {
	// upstream is the site's origin (scheme and host, no path); origin is the same as a string
	upstream *url.URL
	origin   string
	// offline: never contact the upstream (--offline); the cache and the seed only
	offline bool
	// cache is nil when no folder could be used: files are then passed on, not kept
	cache  *siteCache
	client *http.Client
	// downFor and now are fields for the tests
	downFor time.Duration
	now     func() time.Time
	// notify says when the site goes out of reach and comes back (stderr)
	notify func(string)

	mu sync.Mutex
	// checked holds the cache names this run has checked with the site (or downloaded)
	checked map[string]bool
	// downUntil: the site isn't asked before then
	downUntil time.Time
}

// newMirror mirrors site (an origin, as parseSite returns it), keeping files in cache (nil: none)
func newMirror(site string, cache *siteCache, offline bool) (*mirror, error) {
	u, err := url.Parse(site)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: upstreamHeaderTimeout,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
	}
	return &mirror{
		upstream: u,
		origin:   site,
		offline:  offline,
		cache:    cache,
		// The site's redirects go to the browser, which then asks for where they lead
		client:  &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		downFor: upstreamDownFor,
		now:     time.Now,
		notify:  func(msg string) { fmt.Fprintln(os.Stderr, msg) },
		checked: map[string]bool{},
	}, nil
}

// enableSite turns the mirror on: from now on the site's paths come from it
func (s *server) enableSite(m *mirror) {
	s.site = m
}

// parseSite checks a --site value and returns its origin ("https://librecorsa.org"): http or https, a host, nothing
// else ("" stays "": no upstream)
func parseSite(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("--site %s: expected an origin such as %s", raw, defaultSite)
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

// resolveSite is the upstream for this run: --site when given ("" turns it off), else the live site in a release and
// none in a clone, where developers serve their own build
func resolveSite(value string, given, clone bool) (string, error) {
	if !given {
		if clone {
			return "", nil
		}
		value = defaultSite
	}
	return parseSite(value)
}

// defaultSiteCacheDir is where the site's files are kept: beside the browser profile and the converter's tools
func defaultSiteCacheDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(profileRoot(runtime.GOOS, home), "LibreCorsa", "site")
}

func (m *mirror) wasChecked(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.checked[name]
}

func (m *mirror) setChecked(name string) {
	m.mu.Lock()
	m.checked[name] = true
	m.mu.Unlock()
}

// isDown reports whether a network error was seen less than downFor ago
func (m *mirror) isDown() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now().Before(m.downUntil)
}

// markDown takes the site as offline for downFor
func (m *mirror) markDown(err error) {
	m.mu.Lock()
	was := !m.downUntil.IsZero()
	m.downUntil = m.now().Add(m.downFor)
	m.mu.Unlock()
	if !was {
		m.notify(fmt.Sprintf("%s can't be reached (%v): serving what is kept here", m.origin, err))
	}
}

// markUp: the site answered
func (m *mirror) markUp() {
	m.mu.Lock()
	was := !m.downUntil.IsZero()
	m.downUntil = time.Time{}
	m.mu.Unlock()
	if was {
		m.notify(m.origin + " answers again")
	}
}

// siteKind is how often a path is checked with the site
type siteKind int

const (
	// siteFile: once per run (models, textures, sounds, track data)
	siteFile siteKind = iota
	// sitePage: on every request (pages, and the files that say which build is current)
	sitePage
	// siteImmutable: never, once kept (Next's hashed build output)
	siteImmutable
)

// buildFiles are the files at the site's root that say which build is current
var buildFiles = map[string]bool{"offline-manifest.json": true, "build.json": true, "sw.js": true, "manifest.webmanifest": true}

func classify(r *http.Request, urlPath, name string) siteKind {
	switch {
	case strings.HasPrefix(urlPath, "/_next/static/"):
		return siteImmutable
	case r.Header.Get("Sec-Fetch-Mode") == "navigate", buildFiles[name]:
		return sitePage
	}
	// Next's .txt files are a page's payload for client-side navigation, made with each build
	switch path.Ext(name) {
	case ".html", ".txt":
		return sitePage
	}
	return siteFile
}

// cacheName is where a URL path is kept (under files/ and meta/): `/` and `/dir/` as index.html, a name without an
// extension (a page: `/play`) as `<name>.html`, so a page and the folder of its payloads (`/play/__next.play.txt`)
// never need the same name. The segments are splitPath's, so nothing leaves the folder.
func cacheName(segs []string, trailing bool) string {
	if len(segs) == 0 {
		return "index.html"
	}
	name := strings.Join(segs, "/")
	if trailing {
		return name + "/index.html"
	}
	if path.Ext(segs[len(segs)-1]) == "" {
		return name + ".html"
	}
	return name
}

// serveSite answers a GET or HEAD for one of the site's paths (not /mods/ or /__launcher) from the site, the
// cache, the seed or the export's 404 page, as the rules at the top say
func (s *server) serveSite(w http.ResponseWriter, r *http.Request, urlPath string) {
	m := s.site
	segs, trailing, ok := splitPath(urlPath)
	if !ok {
		s.notFound(w, r)
		return
	}
	name := cacheName(segs, trailing)
	kind := classify(r, urlPath, name)
	var kept *keptFile
	if m.cache != nil {
		if kept = m.cache.open(name); kept != nil {
			defer kept.f.Close()
		}
	}
	if kept != nil && (m.offline || kind == siteImmutable || (kind == siteFile && m.wasChecked(name))) {
		m.serveKept(w, r, urlPath, kept)
		return
	}
	if m.offline || m.isDown() {
		s.serveFallback(w, r, urlPath, kept)
		return
	}
	// A part of a file not kept, or a HEAD for one, goes to the site as it is and is not kept. A media element asks
	// for a whole file as `bytes=0-`: that is downloaded and kept like any other (music plays offline then)
	rng := strings.TrimSpace(r.Header.Get("Range"))
	fromStart := rng == "bytes=0-"
	passThrough := kept == nil && ((rng != "" && !fromStart) || r.Method == http.MethodHead)
	res, err := m.fetch(r, kept, passThrough)
	if err != nil {
		if r.Context().Err() != nil {
			return // the browser went away
		}
		m.markDown(err)
		s.serveFallback(w, r, urlPath, kept)
		return
	}
	defer res.Body.Close()
	m.markUp()
	switch {
	case kept != nil && (res.StatusCode == http.StatusNotModified || (res.StatusCode == http.StatusOK && sameVersion(res.Header, kept.meta))):
		// A site that ignored the condition sends the whole file again: none of it is read
		m.setChecked(name)
		m.serveKept(w, r, urlPath, kept)
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		// The site no longer has it: neither does the cache. The site's 404 page is passed on
		if m.cache != nil {
			m.cache.drop(name)
		}
		m.passOn(w, r, urlPath, res)
	case res.StatusCode >= 500:
		s.serveFallback(w, r, urlPath, kept)
	case res.StatusCode == http.StatusOK && !passThrough && r.Method == http.MethodGet:
		m.keepAndServe(w, urlPath, name, res, fromStart)
	default:
		// A redirect, another 4xx, a part of a file, a HEAD
		m.passOn(w, r, urlPath, res)
	}
}

// fetch asks the site for the request's path: conditional on the kept copy's validators, or (passThrough) with the
// browser's Range as it is. Only what a static site needs is sent along; never a cookie.
func (m *mirror) fetch(r *http.Request, kept *keptFile, passThrough bool) (*http.Response, error) {
	u := *m.upstream
	u.Path, u.RawPath, u.RawQuery = r.URL.Path, r.URL.RawPath, r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	for _, k := range []string{"Accept", "Accept-Language", "User-Agent"} {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "librecorsa-launcher/"+version)
	}
	switch {
	case passThrough:
		for _, k := range []string{"Range", "If-Range"} {
			if v := r.Header.Get(k); v != "" {
				req.Header.Set(k, v)
			}
		}
	case kept != nil && kept.meta.ETag != "":
		req.Header.Set("If-None-Match", kept.meta.ETag)
	case kept != nil && kept.meta.LastModified != "":
		req.Header.Set("If-Modified-Since", kept.meta.LastModified)
	}
	return m.client.Do(req)
}

// serveFallback answers without the site: the kept copy, else the seed (the export bundled with the launcher), else
// the export's 404 page
func (s *server) serveFallback(w http.ResponseWriter, r *http.Request, urlPath string, kept *keptFile) {
	if kept != nil {
		s.site.serveKept(w, r, urlPath, kept)
		return
	}
	s.serveGame(w, r, urlPath)
}

// serveKept answers with the kept copy, under the site's validators; Range and the browser's own conditions are
// handled by http.ServeContent
func (m *mirror) serveKept(w http.ResponseWriter, r *http.Request, urlPath string, kept *keptFile) {
	h := w.Header()
	ct := kept.meta.ContentType
	if ct == "" {
		ct = contentType(kept.meta.Path)
	}
	if ct != "" {
		h.Set("Content-Type", ct)
	}
	if kept.meta.ETag != "" {
		h.Set("ETag", kept.meta.ETag)
	}
	// The file's whole size, which the loading screen's progress reads (cloudflare/worker.js)
	h.Set("X-File-Size", strconv.FormatInt(kept.meta.Size, 10))
	setCacheControl(w, urlPath)
	var modtime time.Time
	if t, err := http.ParseTime(kept.meta.LastModified); err == nil {
		modtime = t
	}
	http.ServeContent(w, r, path.Base(kept.meta.Path), modtime, kept.f)
}

// keepAndServe streams a 200 from the site to the browser while writing it to the cache, and keeps it once whole.
// Asked for `bytes=0-` (fromStart), it answers 206 with the whole file when its length is known, so a media element
// knows it may ask for parts later.
func (m *mirror) keepAndServe(w http.ResponseWriter, urlPath, name string, res *http.Response, fromStart bool) {
	h := w.Header()
	copyHeaders(h, res.Header, "Content-Type", "ETag", "Last-Modified", "X-File-Size")
	if h.Get("Content-Type") == "" {
		if ct := contentType(name); ct != "" {
			h.Set("Content-Type", ct)
		}
	}
	// Go's transport takes gzip off on the way (res.Uncompressed): the length is then unknown until the end, and the
	// loading screen goes by X-File-Size
	length := int64(-1)
	if !res.Uncompressed && res.ContentLength >= 0 {
		length = res.ContentLength
		h.Set("Content-Length", strconv.FormatInt(length, 10))
	}
	setCacheControl(w, urlPath)

	var tmp *os.File
	var tmpName string
	if m.cache != nil && keepable(res) {
		tmp, tmpName, _ = m.cache.create()
	}
	discard := func() {
		if tmp != nil {
			tmp.Close()
			m.cache.root.Remove(tmpName)
			tmp = nil
		}
	}
	defer discard()
	if fromStart && length > 0 {
		h.Set("Accept-Ranges", "bytes")
		h.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", length-1, length))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	flush := http.NewResponseController(w)
	buf := make([]byte, 256<<10)
	var n int64
	for {
		k, err := res.Body.Read(buf)
		if k > 0 {
			n += int64(k)
			if tmp != nil {
				if _, werr := tmp.Write(buf[:k]); werr != nil {
					discard() // a full disk: the browser still gets the file
				}
			}
			if _, werr := w.Write(buf[:k]); werr != nil {
				return // the browser went away: nothing is kept
			}
			flush.Flush()
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			// A cut download: the browser must not take what came for the whole file, so the answer is cut too
			discard()
			panic(http.ErrAbortHandler)
		}
	}
	if tmp == nil {
		return
	}
	closeErr := tmp.Close()
	tmp = nil
	stated, _ := strconv.ParseInt(res.Header.Get("X-File-Size"), 10, 64)
	if closeErr != nil || (length >= 0 && n != length) || (stated > 0 && n != stated) {
		m.cache.root.Remove(tmpName)
		return
	}
	meta := keptMeta{ETag: res.Header.Get("ETag"), LastModified: res.Header.Get("Last-Modified"), ContentType: res.Header.Get("Content-Type")}
	if m.cache.commit(tmpName, name, meta) == nil {
		m.setChecked(name)
	}
}

// passOn answers with the site's answer as it is (status, the headers a file needs, the body), keeping nothing
func (m *mirror) passOn(w http.ResponseWriter, r *http.Request, urlPath string, res *http.Response) {
	h := w.Header()
	copyHeaders(h, res.Header, "Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "X-File-Size")
	if !res.Uncompressed && res.ContentLength >= 0 {
		h.Set("Content-Length", strconv.FormatInt(res.ContentLength, 10))
	}
	if loc := res.Header.Get("Location"); loc != "" {
		h.Set("Location", m.localLocation(loc))
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		setCacheControl(w, urlPath)
	} else {
		h.Set("Cache-Control", "no-store")
	}
	w.WriteHeader(res.StatusCode)
	if r.Method != http.MethodHead {
		io.Copy(w, res.Body)
	}
}

// localLocation keeps a redirect on the launcher: an address on the site becomes the same path here
func (m *mirror) localLocation(loc string) string {
	if rest, ok := strings.CutPrefix(loc, m.origin); ok && (rest == "" || strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, "?") || strings.HasPrefix(rest, "#")) {
		if !strings.HasPrefix(rest, "/") {
			rest = "/" + rest
		}
		return rest
	}
	return loc
}

func copyHeaders(dst, src http.Header, names ...string) {
	for _, k := range names {
		if v := src.Get(k); v != "" {
			dst.Set(k, v)
		}
	}
}

// keepable: a whole answer the site lets be stored
func keepable(res *http.Response) bool {
	return res.StatusCode == http.StatusOK && !strings.Contains(strings.ToLower(res.Header.Get("Cache-Control")), "no-store")
}

// sameVersion reports whether a 200 is the kept copy again (weak and strong forms of one ETag are the same)
func sameVersion(h http.Header, meta keptMeta) bool {
	a, b := h.Get("ETag"), meta.ETag
	if a != "" && b != "" {
		return strings.TrimPrefix(a, "W/") == strings.TrimPrefix(b, "W/")
	}
	lm := h.Get("Last-Modified")
	return a == "" && b == "" && lm != "" && lm == meta.LastModified
}

// siteCache is the folder the site's files are kept in, opened through os.Root:
//
//	files/<name>       the file as the browser gets it (decoded)
//	meta/<name>.json   its validators and type (keptMeta)
//	tmp/               downloads in progress, emptied at start
//
// A record names the size and time of the file it describes, so a file replaced without its record (a crash between
// the two renames) is never served under another version's validators.
type siteCache struct {
	root *os.Root
	// mu keeps one commit or drop at a time, so two downloads of a file don't mix a file with the other's record
	mu sync.Mutex
}

// keptMeta is a kept file's record
type keptMeta struct {
	// Path is the cache name, as asked: on a folder that ignores case, a name that differs only in case finds another
	// path's file, and its record says so
	Path         string `json:"path"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	ContentType  string `json:"contentType,omitempty"`
	Size         int64  `json:"size"`
	// ModTime is the file's modification time when it was kept (Unix nanoseconds)
	ModTime int64 `json:"mtime"`
}

// keptFile is an open kept file and its record
type keptFile struct {
	f    *os.File
	meta keptMeta
}

// openSiteCache opens (making it if needed) the cache folder, only this user's, and empties its tmp/
func openSiteCache(dir string) (*siteCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	if err := root.RemoveAll("tmp"); err != nil && !errors.Is(err, fs.ErrNotExist) {
		root.Close()
		return nil, err
	}
	for _, d := range []string{"files", "meta", "tmp"} {
		if err := root.MkdirAll(d, 0o700); err != nil {
			root.Close()
			return nil, err
		}
	}
	return &siteCache{root: root}, nil
}

func (c *siteCache) Close() error { return c.root.Close() }

// open returns the kept copy of name with its record, or nil when there is none that can be trusted
func (c *siteCache) open(name string) *keptFile {
	f, err := c.root.Open("files/" + name)
	if err != nil {
		return nil
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil
	}
	raw, err := c.root.ReadFile("meta/" + name + ".json")
	var meta keptMeta
	if err != nil || json.Unmarshal(raw, &meta) != nil || meta.Path != name || meta.Size != info.Size() || meta.ModTime != info.ModTime().UnixNano() {
		f.Close()
		return nil
	}
	return &keptFile{f: f, meta: meta}
}

// create opens a new temporary file in tmp/
func (c *siteCache) create() (*os.File, string, error) {
	for range 5 {
		name := "tmp/" + randomToken()[:24]
		f, err := c.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return f, name, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("no temporary name")
}

// commit moves a whole download into place as name, then writes its record (through a temporary file too)
func (c *siteCache) commit(tmpName, name string, meta keptMeta) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, record := "files/"+name, "meta/"+name+".json"
	err := c.root.MkdirAll(path.Dir(file), 0o700)
	if err == nil {
		err = c.root.MkdirAll(path.Dir(record), 0o700)
	}
	if err == nil {
		// The old record goes first: a file without its record is never served
		if err = c.root.Remove(record); errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
	}
	if err == nil {
		err = c.root.Rename(tmpName, file)
	}
	if err != nil {
		c.root.Remove(tmpName)
		return err
	}
	info, err := c.root.Stat(file)
	if err != nil {
		return err
	}
	meta.Path, meta.Size, meta.ModTime = name, info.Size(), info.ModTime().UnixNano()
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	f, metaTmp, err := c.create()
	if err != nil {
		return err
	}
	_, err = f.Write(raw)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = c.root.Rename(metaTmp, record)
	}
	if err != nil {
		c.root.Remove(metaTmp)
	}
	return err
}

// drop removes the kept copy of name, record first
func (c *siteCache) drop(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.root.Remove("meta/" + name + ".json")
	c.root.Remove("files/" + name)
}
