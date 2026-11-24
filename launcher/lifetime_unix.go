//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

// watchPID watches a browser this process didn't start (a launcher before an update did): nil when it is gone already.
// It isn't this process's child, so it is asked after every 2 s; one that is gone, or is another user's (its number
// taken again), has ended.
func watchPID(pid int) *browserProcess {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return nil
	}
	exited := make(chan struct{})
	go func() {
		for syscall.Kill(pid, 0) == nil {
			time.Sleep(2 * time.Second)
		}
		close(exited)
	}()
	return &browserProcess{pid: pid, exited: exited}
}

// endBrowser asks a browser to end as when it is quit from its menu (SIGTERM: it closes its windows and saves)
func endBrowser(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// detach starts the launcher after an update in a process group of its own, so it outlives this one and a terminal's
// Ctrl+C meant for this one
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
