//go:build !windows

package main

import (
	"errors"
	"runtime"
)

// knownDocumentsDir is the system's own idea of the Documents folder: XDG's on Linux and the BSDs; macOS has
// ~/Documents (documentsDir's fallback)
func knownDocumentsDir() (string, error) {
	if runtime.GOOS == "darwin" {
		return "", errors.New("macOS: ~/Documents")
	}
	return linuxDocumentsDir()
}
