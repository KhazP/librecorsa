package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesktopEntry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a Linux release's menu entry (and folder names with quotes)")
	}
	dir := filepath.Join(t.TempDir(), "LibreCorsa")
	writeFiles(t, dir, map[string]string{"librecorsa.desktop": "[Desktop Entry]\nType=Application\nName=LibreCorsa\nExec=librecorsa\nIcon=librecorsa\nTerminal=false\n"})
	entry := desktopEntry(dir)
	want := fmt.Sprintf("Exec=\"%s\"\n", filepath.Join(dir, "librecorsa"))
	if !strings.Contains(entry, want) || !strings.Contains(entry, "Icon="+filepath.Join(dir, "librecorsa.png")+"\n") || !strings.Contains(entry, "Name=LibreCorsa\n") {
		t.Errorf("entry:\n%s", entry)
	}
	for _, bad := range []string{`a"b`, "a$b", "a%b", "a`b"} {
		odd := filepath.Join(t.TempDir(), bad)
		writeFiles(t, odd, map[string]string{"librecorsa.desktop": "[Desktop Entry]\nExec=librecorsa\n"})
		if desktopEntry(odd) != "" {
			t.Errorf("%q: an entry for a path it can't write", bad)
		}
	}
	if desktopEntry(t.TempDir()) != "" {
		t.Error("an entry without a template")
	}
	t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "share"))
	installDesktopEntry(dir)
	b, err := os.ReadFile(filepath.Join(os.Getenv("XDG_DATA_HOME"), "applications", desktopEntryName))
	if err != nil || string(b) != entry {
		t.Errorf("installed %q %v", b, err)
	}
}
