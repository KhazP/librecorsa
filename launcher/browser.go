package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// The game reads wheels, pedals and pads over WebHID (and the DualSense's triggers), which only Chromium browsers
// have, so one of those is preferred, opened as an app window on a profile of its own.

// browserCandidates lists where Chrome, Edge, Brave and Chromium usually are on goos, most preferred first. getenv
// and home locate the per-user and Program Files folders.
func browserCandidates(goos string, getenv func(string) string, home string) []string {
	var paths []string
	switch goos {
	case "darwin":
		apps := []string{
			"Google Chrome.app/Contents/MacOS/Google Chrome",
			"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"Brave Browser.app/Contents/MacOS/Brave Browser",
			"Chromium.app/Contents/MacOS/Chromium",
		}
		for _, app := range apps {
			paths = append(paths, filepath.Join("/Applications", app))
			if home != "" {
				paths = append(paths, filepath.Join(home, "Applications", app))
			}
		}
	case "windows":
		exes := []string{
			`Google\Chrome\Application\chrome.exe`,
			`Microsoft\Edge\Application\msedge.exe`,
			`BraveSoftware\Brave-Browser\Application\brave.exe`,
			`Chromium\Application\chrome.exe`,
		}
		roots := []string{getenv("ProgramFiles"), getenv("ProgramFiles(x86)"), getenv("LocalAppData")}
		for _, exe := range exes {
			for _, root := range roots {
				if root != "" {
					paths = append(paths, root+`\`+exe)
				}
			}
		}
	default:
		paths = append(paths,
			"/opt/google/chrome/chrome",
			"/opt/microsoft/msedge/msedge",
			"/opt/brave.com/brave/brave",
			"/usr/lib/chromium/chromium",
			"/snap/bin/chromium",
			// Where snapd puts them on Fedora, Arch and openSUSE (no /snap there)
			"/var/lib/snapd/snap/bin/chromium",
		)
		flatpaks := []string{"com.google.Chrome", "com.microsoft.Edge", "com.brave.Browser", "org.chromium.Chromium"}
		roots := []string{"/var/lib/flatpak/exports/bin"}
		if home != "" {
			// A Flatpak installed for this user only
			roots = append(roots, filepath.Join(home, ".local", "share", "flatpak", "exports", "bin"))
		}
		for _, root := range roots {
			for _, id := range flatpaks {
				paths = append(paths, filepath.Join(root, id))
			}
		}
	}
	return paths
}

// browserCommands are the names Chromium browsers go by on PATH, tried after the usual install locations
var browserCommands = []string{
	"google-chrome", "google-chrome-stable", "chrome",
	"microsoft-edge", "microsoft-edge-stable", "msedge",
	"brave-browser", "brave",
	"chromium", "chromium-browser",
}

// findChromiums returns every Chromium browser found, most preferred first: one that won't start leaves the next
func findChromiums() []string {
	home, _ := os.UserHomeDir()
	var found []string
	add := func(p string) {
		if p != "" && !slices.Contains(found, p) {
			found = append(found, p)
		}
	}
	for _, p := range browserCandidates(runtime.GOOS, os.Getenv, home) {
		if isExecutable(p) {
			add(p)
		}
	}
	for _, name := range browserCommands {
		if p, err := exec.LookPath(name); err == nil {
			add(p)
		}
	}
	return found
}

// isExecutable reports whether p is a file this user may run
func isExecutable(p string) bool {
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

// profileRoot is the folder the game's browser profile goes in: the per-user config folder, or on Windows the local
// (not roaming) app data, since the profile holds the circuits and cars the browser downloaded, hundreds of MB
func profileRoot(goos, home string) string {
	dir, err := os.UserConfigDir()
	if goos == "windows" {
		dir, err = os.UserCacheDir()
	}
	if err != nil || dir == "" {
		dir = filepath.Join(home, ".config")
	}
	return dir
}

// browserProfileDir is the browser profile the game runs in, apart from the player's own: its saves live there. A
// sandboxed browser can only write inside its own folders (a Snap in ~/snap/<name>, a Flatpak in the config folder
// of ~/.var/app/<id>, which its sandbox mounts), so its profile is kept there.
func browserProfileDir(browser, home, root string) string {
	if home != "" {
		// The path as found first (/snap/bin/chromium links to the snap launcher itself), then where its links lead
		paths := []string{filepath.ToSlash(browser)}
		if resolved, err := filepath.EvalSymlinks(browser); err == nil {
			paths = append(paths, filepath.ToSlash(resolved))
		}
		for _, p := range paths {
			if i := strings.Index(p, "/snap/bin/"); i >= 0 && (i == 0 || strings.HasPrefix(p, "/var/lib/snapd/")) {
				return filepath.Join(home, "snap", p[i+len("/snap/bin/"):], "common", "LibreCorsa")
			}
			if i := strings.Index(p, "/flatpak/exports/bin/"); i >= 0 {
				return filepath.Join(home, ".var", "app", p[i+len("/flatpak/exports/bin/"):], "config", "LibreCorsa")
			}
		}
	}
	return filepath.Join(root, "LibreCorsa", "browser")
}

// chromiumArgs opens url as an app window (no tabs or address bar) on the game's own profile
func chromiumArgs(url, profile string) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
	}
}

// defaultBrowserCommand opens url in the system's default browser
func defaultBrowserCommand(goos, url string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}

// openGame opens url in a Chromium app window, trying each browser found in turn, else in the default browser with a
// note on what that loses
func openGame(url string) {
	home, _ := os.UserHomeDir()
	root := profileRoot(runtime.GOOS, home)
	browsers := findChromiums()
	for _, browser := range browsers {
		profile := browserProfileDir(browser, home, root)
		// The player's saves and the launcher's session cookie: this user's alone
		if err := os.MkdirAll(profile, 0o700); err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't create the browser profile %s for %s: %v\n", profile, browser, err)
			continue
		}
		if err := start(browser, chromiumArgs(url, profile)...); err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't start %s: %v\n", browser, err)
			continue
		}
		fmt.Printf("Opened in %s\n", browser)
		return
	}
	if len(browsers) == 0 {
		fmt.Println("No Chrome, Edge, Brave or Chromium found: opening your default browser.")
	} else {
		fmt.Println("No Chrome, Edge, Brave or Chromium would open the game: opening your default browser.")
	}
	fmt.Println("Wheels, pedals and pads need one of those (WebHID); install one for force feedback.")
	name, args := defaultBrowserCommand(runtime.GOOS, url)
	if err := start(name, args...); err != nil {
		fmt.Fprintf(os.Stderr, "Couldn't open a browser (%v). Open %s yourself.\n", err, url)
	}
}

// startGrace is how long a program that fails at once (a sandboxed browser refused its profile folder) takes to say so
const startGrace = 2 * time.Second

// start runs a program without blocking on it: the browser lives on its own (its exit is collected in the background).
// One that quits with an error within startGrace didn't start; one that quits cleanly handed the window to a copy
// already running.
func start(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("it quit at once (%w)", err)
		}
	case <-time.After(startGrace):
	}
	return nil
}
