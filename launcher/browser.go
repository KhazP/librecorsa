package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
			"/var/lib/flatpak/exports/bin/com.google.Chrome",
			"/var/lib/flatpak/exports/bin/com.microsoft.Edge",
			"/var/lib/flatpak/exports/bin/com.brave.Browser",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		)
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

// findChromium returns the first Chromium browser found, or ""
func findChromium() string {
	home, _ := os.UserHomeDir()
	for _, p := range browserCandidates(runtime.GOOS, os.Getenv, home) {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	for _, name := range browserCommands {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

// browserProfileDir is the browser profile the game runs in, apart from the player's own: its saves live there
func browserProfileDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "LibreCorsa", "browser")
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

// openGame opens url in a Chromium app window, else in the default browser with a note on what that loses
func openGame(url string) {
	if browser := findChromium(); browser != "" {
		profile := browserProfileDir()
		if err := os.MkdirAll(profile, 0o755); err == nil {
			err = start(browser, chromiumArgs(url, profile)...)
			if err == nil {
				fmt.Printf("Opened in %s\n", browser)
				return
			}
			fmt.Fprintf(os.Stderr, "Couldn't start %s: %v\n", browser, err)
		}
	}
	fmt.Println("No Chrome, Edge, Brave or Chromium found: opening your default browser.")
	fmt.Println("Wheels, pedals and pads need one of those (WebHID); install one for force feedback.")
	name, args := defaultBrowserCommand(runtime.GOOS, url)
	if err := start(name, args...); err != nil {
		fmt.Fprintf(os.Stderr, "Couldn't open a browser (%v). Open %s yourself.\n", err, url)
	}
}

// start runs a program without blocking on it: the browser lives on its own (its exit is collected in the background)
func start(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
