package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"unicode"
)

// identityApp is what /__launcher answers as "app", so a second launcher can tell the port is held by one of its own
const identityApp = "librecorsa-launcher"

// identityPath is the launcher's own endpoint (outside anything the game's export could hold)
const identityPath = "/__launcher"

// modsPrefix is where mod packages are served, as the game asks for them (src/lib/mods/mod-store.ts MODS_PATH)
const modsPrefix = "/mods/"

// server answers the game's pages and files from one folder and mod packages from another, for one port on loopback
type server struct {
	game *os.Root
	mods *modsFolder
	port int
}

// newServer serves the static export in gameDir and the packages in modsDir to requests for 127.0.0.1:port or
// localhost:port. Both folders must exist.
func newServer(gameDir, modsDir string, port int) (*server, error) {
	game, err := os.OpenRoot(gameDir)
	if err != nil {
		return nil, fmt.Errorf("game folder: %w", err)
	}
	mods, err := openModsFolder(modsDir)
	if err != nil {
		game.Close()
		return nil, fmt.Errorf("mods folder: %w", err)
	}
	return &server{game: game, mods: mods, port: port}, nil
}

func (s *server) Close() error {
	s.mods.Close()
	return s.game.Close()
}

// allowedHost reports whether a request's Host is this launcher's own origin. Anything else is refused, so a web page
// can't point a name of its own at 127.0.0.1 and read the game's files or the player's mods (DNS rebinding).
func (s *server) allowedHost(host string) bool {
	host = strings.ToLower(host)
	port := fmt.Sprint(s.port)
	if host == "127.0.0.1:"+port || host == "localhost:"+port {
		return true
	}
	// On port 80 a browser leaves the port out
	return s.port == 80 && (host == "127.0.0.1" || host == "localhost")
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.allowedHost(r.Host) {
		http.Error(w, "This server only answers http://127.0.0.1:"+fmt.Sprint(s.port), http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Nothing here is for another site's page to embed (an image, a sound, a probe of what is installed)
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")

	p := r.URL.Path
	switch {
	case p == identityPath:
		s.serveIdentity(w)
	case p == modsPrefix+"_index.json":
		s.mods.serveIndex(w, r)
	case strings.HasPrefix(p, cataloguePrefix):
		s.mods.serveCatalogue(w, r, strings.TrimPrefix(p, cataloguePrefix))
	case strings.HasPrefix(p, modsPrefix):
		s.mods.serveFile(w, r, strings.TrimPrefix(p, modsPrefix))
	default:
		s.serveGame(w, r, p)
	}
}

func (s *server) serveIdentity(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"app": identityApp, "version": version})
}

// splitPath turns a request's (already decoded) path into the segments of a relative file name, or reports it unsafe:
// no `.` or `..` segment, no empty segment (`//`), no backslash, colon or control character, nothing a server could
// read as absolute or outside the folder. A trailing slash is allowed and reported.
func splitPath(p string) (segs []string, trailing bool, ok bool) {
	if !strings.HasPrefix(p, "/") || len(p) > 1024 {
		return nil, false, false
	}
	rest := p[1:]
	if rest == "" {
		return nil, false, true
	}
	if strings.HasSuffix(rest, "/") {
		trailing = true
		rest = strings.TrimSuffix(rest, "/")
	}
	if strings.ContainsAny(rest, "\\:") || strings.ContainsFunc(rest, unicode.IsControl) {
		return nil, false, false
	}
	segs = strings.Split(rest, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." {
			return nil, false, false
		}
	}
	return segs, trailing, true
}

// serveGame answers a page or file of the export the way the website does: `/` is index.html, `/play` and `/play/`
// are play.html, `/dir/` is dir/index.html; anything else missing gets 404.html with status 404.
func (s *server) serveGame(w http.ResponseWriter, r *http.Request, p string) {
	segs, trailing, ok := splitPath(p)
	if !ok {
		s.notFound(w, r)
		return
	}
	var candidates []string
	if len(segs) == 0 {
		candidates = []string{"index.html"}
	} else {
		name := strings.Join(segs, "/")
		if !trailing {
			candidates = append(candidates, name)
		}
		candidates = append(candidates, name+".html", name+"/index.html")
	}
	for _, name := range candidates {
		f, err := s.game.Open(name)
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			f.Close()
			continue
		}
		setCacheControl(w, p)
		serveFile(w, r, f, info, name)
		f.Close()
		return
	}
	s.notFound(w, r)
}

// notFound sends the export's 404 page with status 404 (or a plain 404 when the export has none)
func (s *server) notFound(w http.ResponseWriter, r *http.Request) {
	f, err := s.game.Open("404.html")
	if err != nil {
		http.Error(w, "404 page not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		io.Copy(w, f)
	}
}

// setCacheControl: Next's hashed build output never changes under its name, so it is kept for a year. Everything else
// is checked on each use: the pages and the files that say which build is current (offline-manifest.json, build.json)
// must be, and models, sounds and icons keep their names across updates, which costs a 304 on loopback.
func setCacheControl(w http.ResponseWriter, urlPath string) {
	if strings.HasPrefix(urlPath, "/_next/static/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
}

// serveFile answers with a file's content: its type from its name, an ETag from its size and time, and Range,
// If-None-Match and If-Modified-Since handled by http.ServeContent
func serveFile(w http.ResponseWriter, r *http.Request, f *os.File, info os.FileInfo, name string) {
	h := w.Header()
	if ct := contentType(name); ct != "" {
		h.Set("Content-Type", ct)
	}
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, info.Size(), info.ModTime().UnixNano()))
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// contentTypes holds the types the game's files need, rather than the system's table (Windows' registry has been
// known to call .js text/plain, which a browser refuses for a module)
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".htm":         "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".txt":         "text/plain; charset=utf-8",
	".xml":         "application/xml",
	".webmanifest": "application/manifest+json",
	".wasm":        "application/wasm",
	".glb":         "model/gltf-binary",
	".gltf":        "model/gltf+json",
	".bin":         "application/octet-stream",
	".ktx2":        "image/ktx2",
	".webp":        "image/webp",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".avif":        "image/avif",
	".svg":         "image/svg+xml",
	".ico":         "image/x-icon",
	".ogg":         "audio/ogg",
	".mp3":         "audio/mpeg",
	".wav":         "audio/wav",
	".mp4":         "video/mp4",
	".webm":        "video/webm",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".zip":         "application/zip",
}

// contentType is a file's type by its extension; "" leaves it to http.ServeContent (the system's table, then sniffing)
func contentType(name string) string {
	return contentTypes[strings.ToLower(path.Ext(name))]
}
