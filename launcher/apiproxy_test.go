package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const ownOrigin = "http://127.0.0.1:47826"

// apiFixture is a launcher mirroring a fake site whose /api records what reached it
func apiFixture(t *testing.T) (*server, *fakeSite, string) {
	t.Helper()
	site := newFakeSite(t)
	s, cacheDir := mirrorFixture(t, site)
	return s, site, cacheDir
}

func TestAPIOriginRewrite(t *testing.T) {
	s, site, _ := apiFixture(t)
	site.set("/api/config", `{"rooms":true}`, "")
	cases := []struct{ origin, referer, wantOrigin, wantReferer string }{
		// The launcher's own origin becomes the site's: the API answers only its own
		{ownOrigin, ownOrigin + "/play?x=1", site.srv.URL, site.srv.URL + "/play?x=1"},
		{"http://localhost:47826", "http://localhost:47826", site.srv.URL, site.srv.URL + "/"},
		// Any other is passed on as it is, for the site to refuse
		{"https://evil.example", "https://evil.example/page", "https://evil.example", "https://evil.example/page"},
		{"http://127.0.0.1:3000", "", "http://127.0.0.1:3000", ""},
		{"null", "", "null", ""},
		{"", "", "", ""},
	}
	for i, c := range cases {
		get(s, "/api/config", "Origin", c.origin, "Referer", c.referer)
		reqs := site.requests("/api/config")
		if len(reqs) != i+1 {
			t.Fatalf("case %d: %d requests", i, len(reqs))
		}
		r := reqs[i]
		if got := r.Header.Get("Origin"); got != c.wantOrigin {
			t.Errorf("Origin %q: site saw %q, want %q", c.origin, got, c.wantOrigin)
		}
		if got := r.Header.Get("Referer"); got != c.wantReferer {
			t.Errorf("Referer %q: site saw %q, want %q", c.referer, got, c.wantReferer)
		}
		if r.Host != strings.TrimPrefix(site.srv.URL, "http://") {
			t.Errorf("Host %q", r.Host)
		}
	}
}

func TestAPICookiesAndHeaders(t *testing.T) {
	s, site, cacheDir := apiFixture(t)
	site.handle("/api/auth/start/discord", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Set-Cookie", "__Host-lc_auth=state123; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure")
		w.Header().Add("Set-Cookie", "other=1; Domain=librecorsa.org; Path=/; Secure")
		// A site may not set the launcher's session cookie
		w.Header().Add("Set-Cookie", "librecorsa_launcher_47826=chosen; Path=/")
		w.Header().Set("Location", "https://discord.com/oauth2/authorize?state=x")
		w.WriteHeader(http.StatusFound)
	})
	site.handle("/api/auth/callback/discord", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, site.srv.URL+"/play#lc-account=signed-in", http.StatusFound)
	})
	w := get(s, "/api/auth/start/discord?intent=signin&return=/play",
		"Origin", ownOrigin,
		"Cookie", "librecorsa_launcher_47826=secret; __Host-lc_session=s1; librecorsa_launcher_9999=x",
		"X-Forwarded-For", "203.0.113.9",
		"Forwarded", "for=203.0.113.9",
		"Connection", "keep-alive, X-Hop",
		"X-Hop", "1",
	)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "https://discord.com/oauth2/authorize?state=x" {
		t.Errorf("start: %d to %q", w.Code, w.Header().Get("Location"))
	}
	cookies := w.Header().Values("Set-Cookie")
	want := []string{"__Host-lc_auth=state123; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure", "other=1; Path=/; Secure"}
	if strings.Join(cookies, "\n") != strings.Join(want, "\n") {
		t.Errorf("Set-Cookie:\n%s\nwant\n%s", strings.Join(cookies, "\n"), strings.Join(want, "\n"))
	}
	r := site.requests("/api/auth/start/discord")[0]
	if got := r.Header.Get("Cookie"); got != "__Host-lc_session=s1" {
		t.Errorf("site saw Cookie %q", got)
	}
	if r.URL.RawQuery != "intent=signin&return=/play" {
		t.Errorf("query %q", r.URL.RawQuery)
	}
	for _, k := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "X-Hop"} {
		if v := r.Header.Get(k); v != "" {
			t.Errorf("site saw %s: %q", k, v)
		}
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Errorf("headers %v", w.Header())
	}

	// A redirect to the site's own page stays on the launcher
	w = get(s, "/api/auth/callback/discord?code=c&state=s")
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/play#lc-account=signed-in" {
		t.Errorf("callback: %d to %q", w.Code, w.Header().Get("Location"))
	}
	if _, err := os.Stat(filepath.Join(cacheDir, "files", "api")); err == nil {
		t.Error("an /api answer was kept")
	}
}

func TestAPIMethodsAndNeverKept(t *testing.T) {
	s, site, cacheDir := apiFixture(t)
	site.handle("/api/laps", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=30")
		w.Header().Set("ETag", `"laps"`)
		fmt.Fprintf(w, `{"method":%q,"body":%q}`, r.Method, body)
	})
	for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodPut, http.MethodOptions} {
		r := httptest.NewRequest(method, "/api/laps", strings.NewReader(`{"lap":1}`))
		r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
		r.Header.Set("Origin", ownOrigin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"method":"`+method+`"`) || !strings.Contains(w.Body.String(), `{\"lap\":1}`) {
			t.Errorf("%s: %d %s", method, w.Code, w.Body.String())
		}
	}
	for range 2 {
		w := get(s, "/api/laps")
		if w.Header().Get("Cache-Control") != "public, max-age=30" {
			t.Errorf("the site's Cache-Control not passed on: %q", w.Header().Get("Cache-Control"))
		}
	}
	if n := len(site.requests("/api/laps")); n != 6 {
		t.Errorf("site asked %d times, want 6 (nothing kept)", n)
	}
	if entries, _ := os.ReadDir(filepath.Join(cacheDir, "files")); len(entries) != 0 {
		t.Errorf("the cache holds %d entries", len(entries))
	}
	if w := get(s, "/api"); len(site.requests("/api")) != 1 {
		t.Errorf("/api itself not passed on (%d)", w.Code)
	}
}

func TestAPISiteDown(t *testing.T) {
	s, site, _ := apiFixture(t)
	site.srv.Close()
	w := get(s, "/api/config", "Origin", ownOrigin)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), `"ok":false`) {
		t.Errorf("site down: %d %q", w.Code, w.Body.String())
	}
	if !s.site.isDown() {
		t.Error("an /api network error didn't take the site as down")
	}
}

// The race and room servers' sockets pass through: the Upgrade reaches the site with the site's Origin, and bytes
// flow both ways after the 101
func TestAPIWebSocket(t *testing.T) {
	s, site, _ := apiFixture(t)
	gotOrigin := make(chan string, 1)
	site.handle("/api/race/socket", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			http.Error(w, "not an upgrade", http.StatusBadRequest)
			return
		}
		gotOrigin <- r.Header.Get("Origin")
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
		rw.Flush()
		// Echo lines back, upper-cased
		for {
			line, err := rw.ReadString('\n')
			if err != nil {
				return
			}
			rw.WriteString(strings.ToUpper(line))
			rw.Flush()
		}
	})
	ts := httptest.NewServer(s)
	defer ts.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "GET /api/race/socket?slot=1 HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nOrigin: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: librecorsa_launcher_47826=secret\r\n\r\n", testPort, ownOrigin)
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols || !strings.EqualFold(res.Header.Get("Upgrade"), "websocket") {
		t.Fatalf("upgrade: %d %v", res.StatusCode, res.Header)
	}
	if o := <-gotOrigin; o != site.srv.URL {
		t.Errorf("the socket's Origin reached the site as %q", o)
	}
	if c := site.requests("/api/race/socket")[0].Header.Get("Cookie"); c != "" {
		t.Errorf("the launcher's cookie reached the site: %q", c)
	}
	for _, msg := range []string{"hello\n", "lap 1:42.3\n"} {
		io.WriteString(conn, msg)
		got, err := br.ReadString('\n')
		if err != nil || got != strings.ToUpper(msg) {
			t.Fatalf("echo: %q, %v", got, err)
		}
	}
}

func TestAPIWebSocketHostCheck(t *testing.T) {
	s, site, _ := apiFixture(t)
	ts := httptest.NewServer(s)
	defer ts.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "GET /api/race/socket HTTP/1.1\r\nHost: evil.example:%d\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", testPort)
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusForbidden || len(site.requests("")) != 0 {
		t.Errorf("another Host: %d, site asked %d times", res.StatusCode, len(site.requests("")))
	}
}

func TestOwnOrigin(t *testing.T) {
	s, _ := fixture(t)
	for o, want := range map[string]bool{
		ownOrigin:                     true,
		"http://localhost:47826":      true,
		"http://LOCALHOST:47826":      true,
		"https://127.0.0.1:47826":     false,
		"http://127.0.0.1:47827":      false,
		"http://127.0.0.1:47826/play": false,
		"http://127.0.0.1":            false,
		"null":                        false,
		"":                            false,
	} {
		if got := s.ownOrigin(o); got != want {
			t.Errorf("ownOrigin(%q) = %v", o, got)
		}
	}
}
