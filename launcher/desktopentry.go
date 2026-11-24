package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// On Linux a release is a folder unpacked anywhere, and a .desktop file can't name its program relative to itself. So
// each start of a release puts LibreCorsa in the desktop's app menu with the folder's own paths
// (~/.local/share/applications/org.librecorsa.LibreCorsa.desktop, from the librecorsa.desktop and librecorsa.png the
// release carries), and moves it along when the folder moves.

// desktopEntryName is the menu entry's file name
const desktopEntryName = "org.librecorsa.LibreCorsa.desktop"

// desktopEntry is the menu entry for the release in dir, from its librecorsa.desktop: Exec and Icon set to the
// folder's own paths. "" when the release carries no template, or dir holds a character a .desktop line can't.
func desktopEntry(dir string) string {
	template, err := os.ReadFile(filepath.Join(dir, "librecorsa.desktop"))
	if err != nil || strings.ContainsAny(dir, "\"`$\\%\n\r") {
		return ""
	}
	program := filepath.Join(dir, "librecorsa")
	icon := filepath.Join(dir, "librecorsa.png")
	var out bytes.Buffer
	for line := range strings.Lines(string(template)) {
		switch {
		case strings.HasPrefix(line, "Exec="):
			fmt.Fprintf(&out, "Exec=\"%s\"\n", program)
		case strings.HasPrefix(line, "Icon="):
			fmt.Fprintf(&out, "Icon=%s\n", icon)
		case strings.HasPrefix(line, "TryExec="):
			fmt.Fprintf(&out, "TryExec=%s\n", program)
		default:
			out.WriteString(line)
		}
	}
	return out.String()
}

// installDesktopEntry writes the menu entry for the release in dir, when it isn't there as it should be
func installDesktopEntry(dir string) {
	entry := desktopEntry(dir)
	if entry == "" {
		return
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" || !filepath.IsAbs(data) {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		data = filepath.Join(home, ".local", "share")
	}
	apps := filepath.Join(data, "applications")
	file := filepath.Join(apps, desktopEntryName)
	if have, err := os.ReadFile(file); err == nil && string(have) == entry {
		return
	}
	if err := os.MkdirAll(apps, 0o755); err != nil {
		return
	}
	if err := os.WriteFile(file, []byte(entry), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Couldn't add LibreCorsa to the app menu: %v\n", err)
		return
	}
	fmt.Printf("Added LibreCorsa to the app menu (%s)\n", file)
}
