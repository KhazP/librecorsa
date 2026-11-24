//go:build !windows

package main

import (
	"os/exec"
	"runtime"
	"time"
)

// dialogTimeout is how long a message box waits for the player before the launcher goes on (and exits)
const dialogTimeout = 10 * time.Minute

// showError shows message in the system's own message box: osascript on macOS; zenity or kdialog on Linux, whichever
// is there (else it is only in the log). The text is an argument of its own, never part of a script or markup.
func showError(message string) {
	name, args := errorDialogCommand(runtime.GOOS, message, exec.LookPath)
	if name == "" {
		return
	}
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(dialogTimeout):
		cmd.Process.Kill()
	}
}

// errorDialogCommand is the program that shows message on goos, found with lookPath ("" when there is none)
func errorDialogCommand(goos, message string, lookPath func(string) (string, error)) (string, []string) {
	if goos == "darwin" {
		return "/usr/bin/osascript", []string{
			"-e", "on run argv",
			"-e", `display dialog (item 1 of argv) with title "LibreCorsa" buttons {"OK"} default button "OK" with icon stop`,
			"-e", "end run",
			"--", message,
		}
	}
	if p, err := lookPath("zenity"); err == nil {
		return p, []string{"--error", "--no-markup", "--title=LibreCorsa", "--text=" + message}
	}
	if p, err := lookPath("kdialog"); err == nil {
		return p, []string{"--title", "LibreCorsa", "--error", message}
	}
	return "", nil
}

// attachParentConsole is for Windows, whose window app has no console of its own
func attachParentConsole() {}
