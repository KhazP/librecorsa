//go:build windows

package main

import (
	"errors"
	"syscall"
)

// watchPID watches a browser this process didn't start (a launcher before an update did): nil when it is gone already
func watchPID(pid int) *browserProcess {
	if pid <= 0 {
		return nil
	}
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil
	}
	if ev, err := syscall.WaitForSingleObject(h, 0); err != nil || ev == syscall.WAIT_OBJECT_0 {
		syscall.CloseHandle(h)
		return nil
	}
	exited := make(chan struct{})
	go func() {
		syscall.WaitForSingleObject(h, syscall.INFINITE)
		syscall.CloseHandle(h)
		close(exited)
	}()
	return &browserProcess{pid: pid, exited: exited}
}

// endBrowser is for macOS, whose browser stays open with no window; on Windows the browser ends with its last window
func endBrowser(int) error { return errors.New("not on Windows") }
