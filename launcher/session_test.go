package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionOpen(t *testing.T) {
	s, _ := convertFixture(t)
	origin := fmt.Sprintf("http://127.0.0.1:%d", testPort)
	open := func(target string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, target, nil)
		r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
		s.ServeHTTP(w, r)
		return w
	}
	cookieOf := func(w *httptest.ResponseRecorder) *http.Cookie {
		for _, c := range w.Result().Cookies() {
			if c.Name == s.session.cookieName() {
				return c
			}
		}
		return nil
	}

	// No code, or a wrong one: on to the game, without a session
	for _, target := range []string{openPath, openPath + "?code=", openPath + "?code=" + strings.Repeat("0", 64)} {
		w := open(target)
		if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/play" || cookieOf(w) != nil {
			t.Errorf("%s: %d %v %v", target, w.Code, w.Header(), cookieOf(w))
		}
	}

	url := s.session.openURL(origin)
	w := open(strings.TrimPrefix(url, origin))
	c := cookieOf(w)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/play" || c == nil {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Value == "" {
		t.Errorf("cookie %+v", c)
	}
	// The window holding it may call the API, and /__launcher says so
	if w := call(s, http.MethodGet, importsPath, "", "Cookie", c.Name+"="+c.Value); w.Code != http.StatusOK {
		t.Errorf("with the cookie: %d %s", w.Code, w.Body.String())
	}
	id := httptest.NewRequest(http.MethodGet, identityPath, nil)
	id.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	id.AddCookie(c)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, id)
	if !strings.Contains(rec.Body.String(), `"session":true`) {
		t.Errorf("/__launcher with the cookie: %s", rec.Body.String())
	}
	if !strings.Contains(get(s, identityPath).Body.String(), `"session":false`) {
		t.Errorf("/__launcher without it: %s", get(s, identityPath).Body.String())
	}
	if w := call(s, http.MethodGet, importsPath, "", "-Cookie"); w.Code != http.StatusForbidden || decode[statusAnswer](t, w).Code != "session" {
		t.Errorf("without the cookie: %d %s", w.Code, w.Body.String())
	}

	// The code used again: someone else may have had it first, so no cookie of this run works any more
	w = open(strings.TrimPrefix(url, origin))
	if cookieOf(w) != nil {
		t.Error("a spent code set the cookie again")
	}
	if w := call(s, http.MethodGet, importsPath, "", "Cookie", c.Name+"="+c.Value); w.Code != http.StatusForbidden {
		t.Errorf("the session outlived a spent code's second use: %d", w.Code)
	}
}
