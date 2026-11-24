//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// user32 is a KnownDLL: Windows loads it from System32 whatever the search path holds
var (
	user32            = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW   = user32.NewProc("MessageBoxW")
	procAttachConsole = kernel32.NewProc("AttachConsole")
)

const (
	mbOK            = 0x00000000
	mbIconError     = 0x00000010
	mbSetForeground = 0x00010000
	mbTopmost       = 0x00040000

	attachParentProcess = ^uintptr(0) // ATTACH_PARENT_PROCESS, (DWORD)-1
)

// showError shows message in a Windows message box
func showError(message string) {
	if procMessageBoxW.Find() != nil {
		return
	}
	text, err := syscall.UTF16PtrFromString(message)
	if err != nil {
		return
	}
	title, _ := syscall.UTF16PtrFromString("LibreCorsa")
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbOK|mbIconError|mbSetForeground|mbTopmost)
}

// attachParentConsole gives the launcher the console of the command prompt it was started from, if any: a release is
// built as a window app (-H=windowsgui), which has no console, so `LibreCorsa.exe --no-browser` would print nowhere.
// Started from Explorer there is none to attach to, and output sent to a file or a pipe stays there.
func attachParentConsole() {
	if leadsSomewhere(os.Stdout) {
		return
	}
	if procAttachConsole.Find() != nil {
		return
	}
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = out
		os.Stderr = out
	}
}

// leadsSomewhere reports whether f is a console, a file or a pipe (a window app's standard streams are usually none)
func leadsSomewhere(f *os.File) bool {
	if f == nil {
		return false
	}
	t, err := syscall.GetFileType(syscall.Handle(f.Fd()))
	return err == nil && t != syscall.FILE_TYPE_UNKNOWN
}
