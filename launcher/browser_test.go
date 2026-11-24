package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBrowserCandidates(t *testing.T) {
	env := map[string]string{"ProgramFiles": `C:\Program Files`, "LocalAppData": `C:\Users\p\AppData\Local`}
	getenv := func(k string) string { return env[k] }
	cases := map[string][]string{
		"darwin":  {"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/p/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"},
		"windows": {`C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Users\p\AppData\Local\Microsoft\Edge\Application\msedge.exe`},
		"linux":   {"/opt/google/chrome/chrome", "/snap/bin/chromium", "/Users/p/.local/share/flatpak/exports/bin/com.google.Chrome"},
	}
	for goos, want := range cases {
		got := browserCandidates(goos, getenv, "/Users/p")
		for _, w := range want {
			if !slices.Contains(got, w) {
				t.Errorf("%s: %q not among %v", goos, w, got)
			}
		}
		if !strings.Contains(strings.ToLower(got[0]), "chrome") {
			t.Errorf("%s: Chrome isn't first: %v", goos, got)
		}
	}
}

func TestChromiumArgs(t *testing.T) {
	got := chromiumArgs("http://127.0.0.1:47826/play", "/cfg/LibreCorsa/browser")
	want := []string{"--app=http://127.0.0.1:47826/play", "--user-data-dir=/cfg/LibreCorsa/browser", "--no-first-run", "--no-default-browser-check"}
	if !slices.Equal(got, want) {
		t.Errorf("chromiumArgs = %v", got)
	}
}

func TestDefaultBrowserCommand(t *testing.T) {
	for goos, want := range map[string]string{"darwin": "open", "windows": "rundll32", "linux": "xdg-open"} {
		if name, args := defaultBrowserCommand(goos, "u"); name != want || args[len(args)-1] != "u" {
			t.Errorf("%s: %s %v", goos, name, args)
		}
	}
}

func TestBrowserProfileDir(t *testing.T) {
	root := "/home/p/.config"
	cases := map[string]string{
		"/opt/google/chrome/chrome":                                      "/home/p/.config/LibreCorsa/browser",
		"/var/lib/snapd/snap/bin/chromium":                               "/home/p/snap/chromium/common/LibreCorsa",
		"/snap/bin/chromium":                                             "/home/p/snap/chromium/common/LibreCorsa",
		"/var/lib/flatpak/exports/bin/com.google.Chrome":                 "/home/p/.var/app/com.google.Chrome/config/LibreCorsa",
		"/home/p/.local/share/flatpak/exports/bin/org.chromium.Chromium": "/home/p/.var/app/org.chromium.Chromium/config/LibreCorsa",
	}
	for browser, want := range cases {
		if got := filepath.ToSlash(browserProfileDir(browser, "/home/p", root)); got != want {
			t.Errorf("browserProfileDir(%q) = %q, want %q", browser, got, want)
		}
	}
}

func TestStartReportsAQuickFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	if _, err := start("sh", "-c", "exit 3"); err == nil {
		t.Error("a program that quits with an error at once counts as started")
	}
	proc, err := start("sh", "-c", "exit 0")
	if err != nil {
		t.Errorf("a program that hands over and quits cleanly counts as failed: %v", err)
	}
	if proc != nil {
		t.Error("a program that handed over is watched")
	}
}

func TestStartWatchesABrowserThatStays(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	proc, err := start("sh", "-c", "sleep 3")
	if err != nil || proc == nil || proc.pid <= 0 {
		t.Fatalf("a program still running after the grace isn't watched: %v %v", proc, err)
	}
	select {
	case <-proc.exited:
		t.Fatal("it ended at once")
	default:
	}
	select {
	case <-proc.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("its end wasn't seen")
	}
}

func TestWatchPID(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep")
	}
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	proc := watchPID(cmd.Process.Pid)
	if proc == nil {
		t.Fatal("a running process isn't watched")
	}
	cmd.Process.Kill()
	cmd.Wait()
	select {
	case <-proc.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("its end wasn't seen")
	}
	if watchPID(cmd.Process.Pid) != nil {
		t.Error("a process that ended is watched")
	}
}
