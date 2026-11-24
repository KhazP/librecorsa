//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

// procTree is a program started with what it starts in turn
type procTree struct {
	cmd *exec.Cmd
}

// startTree starts cmd in a process group of its own, with no console window of its own
func startTree(cmd *exec.Cmd) (*procTree, error) {
	const createNewProcessGroup = 0x00000200
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | createNoWindow}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &procTree{cmd: cmd}, nil
}

// stop ends the program and every process it started (taskkill /T), with a fixed argv and the system's own copy
func (t *procTree) stop(exited <-chan struct{}) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	kill := exec.Command(filepath.Join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(t.cmd.Process.Pid))
	if kill.Run() != nil {
		t.cmd.Process.Kill()
	}
}

// release lets go of the tree once the program has been waited for (nothing to let go of here)
func (t *procTree) release() {}
