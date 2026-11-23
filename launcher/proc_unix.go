//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

// prepareTree starts the program in a process group of its own, so stopping it stops what it started too (uv,
// Python, the Node scripts Python runs)
func prepareTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// stopTree asks the program's process group to end, then kills what is left after killGrace
func stopTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid := cmd.Process.Pid
	syscall.Kill(-pgid, syscall.SIGTERM)
	go func() {
		time.Sleep(killGrace)
		syscall.Kill(-pgid, syscall.SIGKILL)
	}()
}
