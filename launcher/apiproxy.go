package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

// The game's online side (cloudflare/api: lap boards, rooms, races, accounts) on the mirrored site. A production
// build calls /api on its own origin, which under the launcher is http://127.0.0.1:<port>, and opens its WebSockets
// there too (src/lib/net/online-config.ts onlineSocketUrl), so the launcher passes /api on to <site>/api, never kept.
//
//   - Origin: the API answers only its own origin (cloudflare/api/index.ts allowedOrigin), so the launcher's own
//     (http://127.0.0.1:<port>, http://localhost:<port>) becomes the site's; any other is passed on as it is, and the
//     site refuses it as it would on the web. Referer likewise.
//   - Cookies: the account cookies (cloudflare/api/accounts/http.ts) are `__Host-` and Secure on https. Chrome (158,
//     checked with the real browser on macOS) keeps and sends Secure and `__Host-` cookies on http://127.0.0.1:<port>
//     and http://localhost:<port>, which it counts as secure, for navigations and fetches alike, so they pass as they
//     are, with only Domain= taken off (there is none today). The launcher's own session cookie
//     (session.go) is never sent on, and the site can't set one of that name.
//   - X-Forwarded-* and Forwarded aren't sent (httputil.ReverseProxy with Rewrite drops them); hop-by-hop headers go
//     as ReverseProxy drops them, except an Upgrade, which it carries through for WebSockets.

// onlinePrefix is the game's online side
const onlinePrefix = "/api/"

// isOnlinePath reports whether p is the API's (passed on to the site)
func isOnlinePath(p string) bool {
	return p == "/api" || strings.HasPrefix(p, onlinePrefix)
}

// newAPIProxy passes /api on to the mirror's site
func newAPIProxy(s *server, m *mirror) *httputil.ReverseProxy {
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		// The game gives every read of the API 8 s (online-config.ts CONFIG_TIMEOUT_MS); a lap post may take longer
		ResponseHeaderTimeout: 30 * time.Second,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(m.upstream)
			h := pr.Out.Header
			if o := h.Get("Origin"); o != "" && s.ownOrigin(o) {
				h.Set("Origin", m.origin)
			}
			if ref := h.Get("Referer"); ref != "" {
				if rest, ok := s.trimOwnOrigin(ref); ok {
					h.Set("Referer", m.origin+rest)
				}
			}
			withoutLauncherCookies(h)
		},
		Transport: transport,
		ModifyResponse: func(res *http.Response) error {
			m.markUp()
			h := res.Header
			if cookies := h.Values("Set-Cookie"); len(cookies) > 0 {
				h.Del("Set-Cookie")
				for _, c := range cookies {
					if name, _, _ := strings.Cut(c, "="); strings.HasPrefix(strings.TrimSpace(name), sessionCookiePrefix) {
						continue
					}
					h.Add("Set-Cookie", withoutDomain(c))
				}
			}
			// A redirect to the site's own pages (an account's sign-in coming back) stays on the launcher
			if loc := h.Get("Location"); loc != "" {
				h.Set("Location", m.localLocation(loc))
			}
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Cross-Origin-Resource-Policy", "same-origin")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				return // the browser went away
			}
			m.markDown(err)
			writeOnlineError(w, http.StatusBadGateway, "The online side can't be reached")
		},
	}
}

// serveOnline passes a request for /api on to the site, or says it is offline (--offline)
func (s *server) serveOnline(w http.ResponseWriter, r *http.Request) {
	if s.site.offline {
		writeOnlineError(w, http.StatusServiceUnavailable, "Offline")
		return
	}
	s.api.ServeHTTP(w, r)
}

// writeOnlineError answers like the API does when it fails ({ ok: false, error }), which the game reads as a server
// out of reach
func writeOnlineError(w http.ResponseWriter, status int, msg string) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

// ownOrigin reports whether an Origin is the launcher's own (http://127.0.0.1:<port> or http://localhost:<port>)
func (s *server) ownOrigin(origin string) bool {
	host, ok := strings.CutPrefix(origin, "http://")
	return ok && host != "" && !strings.ContainsAny(host, "/?#") && s.allowedHost(host)
}

// trimOwnOrigin returns what follows the launcher's own origin in an address ("/play?x"), if it starts with it
func (s *server) trimOwnOrigin(addr string) (string, bool) {
	rest, ok := strings.CutPrefix(addr, "http://")
	if !ok {
		return "", false
	}
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	if !s.allowedHost(rest[:end]) {
		return "", false
	}
	tail := rest[end:]
	if !strings.HasPrefix(tail, "/") {
		tail = "/" + tail
	}
	return tail, true
}

// withoutLauncherCookies takes the launchers' session cookies (any port's: a browser sends a host's cookies to each
// of its ports) out of a request's Cookie headers
func withoutLauncherCookies(h http.Header) {
	values := h.Values("Cookie")
	if len(values) == 0 {
		return
	}
	var kept []string
	for _, v := range values {
		for _, part := range strings.Split(v, ";") {
			part = strings.TrimSpace(part)
			name, _, _ := strings.Cut(part, "=")
			if part == "" || strings.HasPrefix(strings.TrimSpace(name), sessionCookiePrefix) {
				continue
			}
			kept = append(kept, part)
		}
	}
	h.Del("Cookie")
	if len(kept) > 0 {
		h.Set("Cookie", strings.Join(kept, "; "))
	}
}

// withoutDomain takes the Domain attribute off a Set-Cookie value: the site's domain isn't the launcher's, and a
// browser refuses a cookie for another domain
func withoutDomain(setCookie string) string {
	parts := strings.Split(setCookie, ";")
	out := parts[:1]
	for _, a := range parts[1:] {
		if k, _, _ := strings.Cut(a, "="); strings.EqualFold(strings.TrimSpace(k), "domain") {
			continue
		}
		out = append(out, a)
	}
	return strings.Join(out, ";")
}
