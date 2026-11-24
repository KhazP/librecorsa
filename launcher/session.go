package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
)

// The launcher's session: what tells the game's own window from another program on the computer. The server listens
// on 127.0.0.1, which every user of the computer can reach, and the converter's API (api.go) starts programs and
// lists the player's folders, so it answers only a browser holding this run's session cookie.
//
// The cookie is handed out once per opening: the launcher opens the game at `/__launcher/open?code=<code>`, a code
// good for one use, whose answer sets the cookie (HttpOnly, SameSite=Strict, a value minted for this run) and moves on
// to /play. A code is on the browser's command line, which other users can list, so it is spent on first use; one
// used a second time means someone else got there too, and the session is ended for everyone (no cookie of this run
// works after that) until the launcher starts again.

// openPath hands out the session cookie, given a code
const openPath = identityPath + "/open"

type session struct {
	port int

	mu     sync.Mutex
	secret string
	// codes are the one-time codes not used yet; spent the ones that were
	codes map[string]bool
	spent map[string]bool
}

func newSession(port int) *session {
	return &session{port: port, secret: randomToken(), codes: map[string]bool{}, spent: map[string]bool{}}
}

// randomToken is 32 random bytes in hex
func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand doesn't fail on the systems a release is built for
	}
	return hex.EncodeToString(b)
}

// sessionCookiePrefix starts the session cookie's name, which never goes on to the site (apiproxy.go)
const sessionCookiePrefix = "librecorsa_launcher_"

// adopt keeps the session of the launcher this one took over from after an update, so the game's window, still open,
// keeps converting
func (s *session) adopt(secret string) {
	if len(secret) != 64 || strings.Trim(secret, "0123456789abcdef") != "" {
		return
	}
	s.mu.Lock()
	s.secret = secret
	s.mu.Unlock()
}

// current is the session's secret, for the launcher an update starts
func (s *session) current() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.secret
}

// cookieName is per port: a browser sends a host's cookies to each of its ports, and another launcher (--port) has
// its own
func (s *session) cookieName() string { return fmt.Sprintf("%s%d", sessionCookiePrefix, s.port) }

// openURL is an address that opens the game with this run's session, good once
func (s *session) openURL(origin string) string {
	code := randomToken()
	s.mu.Lock()
	s.codes[code] = true
	s.mu.Unlock()
	return origin + openPath + "?code=" + code
}

// valid reports whether a request carries this run's session cookie
func (s *session) valid(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName())
	if err != nil {
		return false
	}
	s.mu.Lock()
	secret := s.secret
	s.mu.Unlock()
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(secret)) == 1
}

// serveOpen spends a code: a good one sets the session cookie; any answer moves on to the game, which runs either way
// (only converting needs the session)
func (s *session) serveOpen(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	s.mu.Lock()
	switch {
	case s.codes[code]:
		delete(s.codes, code)
		s.spent[code] = true
		http.SetCookie(w, &http.Cookie{
			Name:     s.cookieName(),
			Value:    s.secret,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			// Kept with the browser profile, so opening the game again while this launcher runs keeps it; the next run
			// mints another
			MaxAge: 30 * 24 * 60 * 60,
		})
	case s.spent[code]:
		// Its first use may not have been the game's window: nobody's cookie works from now on
		s.secret = randomToken()
		fmt.Fprintln(os.Stderr, "The address that opens the game was used twice, so converting is switched off until LibreCorsa starts again.")
	}
	s.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, "/play", http.StatusSeeOther)
}
