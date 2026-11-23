//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

// prepareTree starts the program in a process group of its own, with no console window of its own
func prepareTree(cmd *exec.Cmd) {
	const createNewProcessGroup = 0x00000200
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | createNoWindow}
}

// stopTree ends the program and every process it started (taskkill /T), with a fixed argv and the system's own copy
func stopTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	kill := exec.Command(filepath.Join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	if kill.Run() != nil {
		cmd.Process.Kill()
	}
}
