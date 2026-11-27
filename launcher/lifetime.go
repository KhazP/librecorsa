package main

import (
	"context"
	"fmt"
	"regexp"
	"sync"
	"time"
)

// How long the launcher lives. It is an app, not a server left running: it quits when the game's window closes.
//
//   - The browser it started (browser.go), on a profile of its own, is watched: that browser ends with its last
//     window, and the launcher with it. On macOS a browser stays open with no window, so there the game's page also
//     says when it goes (pagehide), and once no page of the game is left the launcher asks the browser to end.
//   - With the system's default browser (no Chromium found) there is no process of its own to watch: the game's page
//     calls home every ~30 s (src/lib/mods/launcher-imports.ts), and the launcher quits once none has for 2 minutes.
//
// It never quits while a conversion or a download runs (jobs.go), nor while an update is being put in place: it waits
// for it to end. With --no-browser it serves until stopped, as before.

const (
	// beatTimeout is how long the launcher waits for a page's call, without a window of its own to watch
	beatTimeout = 2 * time.Minute
	// closeGrace is how long after the game's last page said it closed the browser is asked to end (macOS): a page
	// reloading says it closed, then calls again at once
	closeGrace = 15 * time.Second
	// endGrace is how long a browser asked to end has before the launcher goes anyway
	endGrace = 15 * time.Second
	// maxPages bounds the pages remembered at once
	maxPages = 64
)

// pageIDPattern is what a page's id may look like (the page makes a random one)
var pageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// browserProcess is the browser the launcher started (or the one a launcher before an update did), which ends with
// the game's window
type browserProcess struct {
	pid    int
	exited <-chan struct{}
}

type lifetime struct {
	now     func() time.Time
	started time.Time
	// busy says a job or an update's install runs: the launcher doesn't quit under one
	busy func() bool
	// endsBrowser asks the browser to end, where it stays open without a window (macOS); nil elsewhere
	endsBrowser func(pid int) error
	// serveOnly: --no-browser, nothing to watch
	serveOnly bool

	mu      sync.Mutex
	browser *browserProcess
	// browserGone is when the watched browser ended: a page calling after that is a window opened again
	browserGone time.Time
	// pages are the game's pages that called, and when they last did; lastBeat is the latest call of any
	pages    map[string]time.Time
	lastBeat time.Time
	// closedAt is when the last page left said it closed (zero while a page is there)
	closedAt time.Time
	// askedEnd is when the browser was asked to end
	askedEnd time.Time
	waiting  bool

	done     chan struct{}
	doneOnce sync.Once
	reason   string
}

func newLifetime(serveOnly bool, busy func() bool, endsBrowser func(pid int) error) *lifetime {
	return &lifetime{
		now:         time.Now,
		started:     time.Now(),
		busy:        busy,
		endsBrowser: endsBrowser,
		serveOnly:   serveOnly,
		pages:       map[string]time.Time{},
		done:        make(chan struct{}),
	}
}

// watch makes b the browser the launcher lives with (nil: none, so the pages' calls decide)
func (l *lifetime) watch(b *browserProcess) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.browser = b
}

// browserPID is the watched browser's (0 when none), for a launcher that takes over after an update
func (l *lifetime) browserPID() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.browser == nil {
		return 0
	}
	return l.browser.pid
}

// beat records a page's call; closing says the page is going (it closed or reloads)
func (l *lifetime) beat(page string, closing bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if closing {
		if _, ok := l.pages[page]; ok {
			delete(l.pages, page)
			if len(l.pages) == 0 {
				l.closedAt = now
				fmt.Println("The game's last page closed")
			}
		}
		return
	}
	if len(l.pages) == 0 {
		fmt.Println("The game's page is open")
	}
	if _, ok := l.pages[page]; !ok && len(l.pages) >= maxPages {
		// The one not heard from for longest makes room
		oldest := ""
		for id, t := range l.pages {
			if oldest == "" || t.Before(l.pages[oldest]) {
				oldest = id
			}
		}
		delete(l.pages, oldest)
	}
	l.pages[page] = now
	l.lastBeat = now
	l.closedAt = time.Time{}
}

// Done is closed when the launcher should quit
func (l *lifetime) Done() <-chan struct{} { return l.done }

// Reason is why it quits
func (l *lifetime) Reason() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.reason
}

// step looks at where things are: whether to ask the browser to end (its pid, else 0), and why to quit ("" not yet)
func (l *lifetime) step() (endPID int, quit string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.serveOnly {
		return 0, ""
	}
	now := l.now()
	hadPages := len(l.pages) > 0
	for id, t := range l.pages {
		if now.Sub(t) >= beatTimeout {
			delete(l.pages, id)
		}
	}
	if hadPages && len(l.pages) == 0 && l.closedAt.IsZero() {
		l.closedAt = now
	}
	if b := l.browser; b != nil {
		select {
		case <-b.exited:
			l.browser = nil
			l.browserGone = now
			return 0, "the game's window was closed"
		default:
		}
		if !l.askedEnd.IsZero() {
			if now.Sub(l.askedEnd) >= endGrace {
				return 0, "the game's window was closed (the browser didn't end when asked)"
			}
			return 0, ""
		}
		if l.endsBrowser != nil && len(l.pages) == 0 && !l.closedAt.IsZero() && now.Sub(l.closedAt) >= closeGrace {
			l.askedEnd = now
			return b.pid, ""
		}
		return 0, ""
	}
	if !l.browserGone.IsZero() && !l.lastBeat.After(l.browserGone) {
		// No page has called since the browser ended
		return 0, "the game's window was closed"
	}
	last := l.started
	if l.lastBeat.After(last) {
		last = l.lastBeat
	}
	if now.Sub(last) >= beatTimeout {
		return 0, fmt.Sprintf("no page of the game has called for %s", beatTimeout)
	}
	return 0, ""
}

// run decides, once a second, until it is time to quit or ctx ends
func (l *lifetime) run(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		pid, quit := l.step()
		if pid != 0 {
			fmt.Println("The game's window was closed: asking the browser to end")
			if err := l.endsBrowser(pid); err != nil {
				fmt.Printf("Couldn't ask the browser to end (%v)\n", err)
			}
		}
		if quit == "" {
			continue
		}
		if l.busy != nil && l.busy() {
			l.mu.Lock()
			first := !l.waiting
			l.waiting = true
			l.mu.Unlock()
			if first {
				fmt.Printf("%s: quitting once the conversion, download or update running ends\n", quit)
			}
			continue
		}
		l.doneOnce.Do(func() {
			l.mu.Lock()
			l.reason = quit
			l.mu.Unlock()
			close(l.done)
		})
		return
	}
}
