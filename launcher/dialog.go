package main

import (
	"fmt"
	"os"
)

// What the launcher says when it can't start. It has no window of its own: started as an app (from the Finder, the
// Start menu, a file manager) the player would see nothing at all, so a failure to start is also shown in a message
// box of the system's (showError, per platform), with where the log is. Started from a terminal, or with
// --no-browser, it is only printed.

// failStart reports why the launcher can't start, in a message box too when it runs as an app, and returns the exit
// code
func failStart(asApp bool, message string) int {
	fmt.Fprintln(os.Stderr, message)
	if asApp {
		showError(message + "\n\nDetails are in " + logPath())
	}
	return 1
}
