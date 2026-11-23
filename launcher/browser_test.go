package main

import (
	"slices"
	"strings"
	"testing"
)

func TestBrowserCandidates(t *testing.T) {
	env := map[string]string{"ProgramFiles": `C:\Program Files`, "LocalAppData": `C:\Users\p\AppData\Local`}
	getenv := func(k string) string { return env[k] }
	cases := map[string][]string{
		"darwin":  {"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/p/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"},
		"windows": {`C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Users\p\AppData\Local\Microsoft\Edge\Application\msedge.exe`},
		"linux":   {"/opt/google/chrome/chrome", "/snap/bin/chromium"},
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
