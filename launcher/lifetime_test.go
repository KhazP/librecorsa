package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// clockLifetime is a lifetime on a clock the test moves
func clockLifetime(serveOnly bool, busy *atomic.Bool, endsBrowser bool) (*lifetime, *time.Time) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	var ends func(int) error
	if endsBrowser {
		ends = func(int) error { return nil }
	}
	l := newLifetime(serveOnly, func() bool { return busy != nil && busy.Load() }, ends)
	l.now = func() time.Time { return now }
	l.started = now
	return l, &now
}

func fakeBrowser(pid int) (*browserProcess, func()) {
	exited := make(chan struct{})
	return &browserProcess{pid: pid, exited: exited}, func() { close(exited) }
}

func TestLifetimeQuitsWithTheBrowser(t *testing.T) {
	l, now := clockLifetime(false, nil, false)
	b, exit := fakeBrowser(42)
	l.watch(b)
	l.beat("page-one-id", false)
	*now = now.Add(10 * time.Minute)
	if _, quit := l.step(); quit != "" {
		t.Fatalf("quit with the browser open: %s", quit)
	}
	if l.browserPID() != 42 {
		t.Errorf("browserPID %d", l.browserPID())
	}
	exit()
	if _, quit := l.step(); quit == "" {
		t.Fatal("didn't quit when the browser ended")
	}
	// Still: the window doesn't come back by itself
	if _, quit := l.step(); quit == "" {
		t.Fatal("changed its mind")
	}
}

func TestLifetimeAfterTheBrowserAWindowOpenedAgainKeepsIt(t *testing.T) {
	l, now := clockLifetime(false, nil, false)
	b, exit := fakeBrowser(42)
	l.watch(b)
	exit()
	l.step()
	// A window opened again (a second start, while this one waited for a job): its page calls
	*now = now.Add(time.Second)
	l.beat("page-two-id", false)
	*now = now.Add(time.Minute)
	if _, quit := l.step(); quit != "" {
		t.Fatalf("quit with a page calling: %s", quit)
	}
	*now = now.Add(beatTimeout)
	if _, quit := l.step(); quit == "" {
		t.Fatal("didn't quit once the page stopped calling")
	}
}

func TestLifetimeWithoutABrowserFollowsThePagesCalls(t *testing.T) {
	l, now := clockLifetime(false, nil, false)
	l.watch(nil)
	// The page takes a while to open
	*now = now.Add(90 * time.Second)
	if _, quit := l.step(); quit != "" {
		t.Fatalf("quit before a page could call: %s", quit)
	}
	for range 10 {
		l.beat("page-one-id", false)
		*now = now.Add(30 * time.Second)
		if _, quit := l.step(); quit != "" {
			t.Fatalf("quit with a page calling: %s", quit)
		}
	}
	// A page closing doesn't end it at once (it may come back from the browser's back button)
	l.beat("page-one-id", true)
	if _, quit := l.step(); quit != "" {
		t.Fatalf("quit at a page's close: %s", quit)
	}
	*now = now.Add(beatTimeout)
	if _, quit := l.step(); quit == "" {
		t.Fatal("didn't quit 2 minutes after the last call")
	}
}

func TestLifetimeWaitsForAJob(t *testing.T) {
	var busy atomic.Bool
	busy.Store(true)
	l, _ := clockLifetime(false, &busy, false)
	b, exit := fakeBrowser(42)
	l.watch(b)
	exit()
	go l.run(t.Context())
	select {
	case <-l.Done():
		t.Fatal("quit under a running job")
	case <-time.After(1500 * time.Millisecond):
	}
	busy.Store(false)
	select {
	case <-l.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("didn't quit once the job ended")
	}
	if l.Reason() == "" {
		t.Error("no reason")
	}
}

func TestLifetimeEndsABrowserThatStaysWithoutItsWindow(t *testing.T) {
	l, now := clockLifetime(false, nil, true)
	b, exit := fakeBrowser(42)
	l.watch(b)
	l.beat("page-one-id", false)
	// A reload: the page says it goes, and the new one calls at once
	l.beat("page-one-id", true)
	*now = now.Add(2 * time.Second)
	l.beat("page-two-id", false)
	*now = now.Add(time.Minute)
	if pid, quit := l.step(); pid != 0 || quit != "" {
		t.Fatalf("a reload ended it: %d %q", pid, quit)
	}
	// The window closes: the last page says so, and none calls
	l.beat("page-two-id", true)
	*now = now.Add(closeGrace - time.Second)
	if pid, _ := l.step(); pid != 0 {
		t.Fatal("asked the browser to end before the grace")
	}
	*now = now.Add(2 * time.Second)
	if pid, _ := l.step(); pid != 42 {
		t.Fatal("didn't ask the browser to end")
	}
	if pid, _ := l.step(); pid != 0 {
		t.Fatal("asked twice")
	}
	exit()
	if _, quit := l.step(); quit == "" {
		t.Fatal("didn't quit when the browser ended")
	}
}

func TestLifetimeGoesWhenTheBrowserWontEnd(t *testing.T) {
	l, now := clockLifetime(false, nil, true)
	b, _ := fakeBrowser(42)
	l.watch(b)
	l.beat("page-one-id", false)
	l.beat("page-one-id", true)
	*now = now.Add(closeGrace)
	l.step()
	*now = now.Add(endGrace)
	if _, quit := l.step(); quit == "" {
		t.Fatal("waits for ever on a browser that won't end")
	}
}

func TestLifetimeWithoutAWindowToEndWaitsForTheBrowser(t *testing.T) {
	// Windows and Linux: the browser ends with its window; a closed page alone ends nothing
	l, now := clockLifetime(false, nil, false)
	b, _ := fakeBrowser(42)
	l.watch(b)
	l.beat("page-one-id", false)
	l.beat("page-one-id", true)
	*now = now.Add(time.Hour)
	if pid, quit := l.step(); pid != 0 || quit != "" {
		t.Fatalf("%d %q", pid, quit)
	}
}

func TestLifetimeServeOnlyNeverQuits(t *testing.T) {
	l, now := clockLifetime(true, nil, true)
	*now = now.Add(24 * time.Hour)
	if pid, quit := l.step(); pid != 0 || quit != "" {
		t.Fatalf("%d %q", pid, quit)
	}
}

func TestLifetimeRemembersFewPages(t *testing.T) {
	l, now := clockLifetime(false, nil, false)
	for i := range maxPages * 3 {
		*now = now.Add(time.Millisecond)
		l.beat("page-"+time.Duration(i).String()+"-id", false)
	}
	if len(l.pages) > maxPages {
		t.Errorf("%d pages remembered", len(l.pages))
	}
}
