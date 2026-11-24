//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

// procTree is a program started with what it starts in turn (uv, Python, the Node scripts Python runs): a process
// group of its own, so stopping it stops them too
type procTree struct {
	pgid int
}

// signalGroup sends a signal to a process group (a variable so the tests can see what is sent)
var signalGroup = func(pgid int, sig syscall.Signal) error { return syscall.Kill(-pgid, sig) }

// startTree starts cmd as the leader of a new process group
func startTree(cmd *exec.Cmd) (*procTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &procTree{pgid: cmd.Process.Pid}, nil
}

// stop asks the process group to end, then kills what is left of it after killGrace. exited closes once the program
// has been waited for: the kill is called off then, since a group with nothing left in it frees its id for another
// process, whose group the kill would reach. (Asked to end, the converter's programs do; what lingers past its leader
// is still killed by the timer while the group holds its id.)
func (t *procTree) stop(exited <-chan struct{}) {
	signalGroup(t.pgid, syscall.SIGTERM)
	grace := killGrace
	go func() {
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-exited:
		case <-timer.C:
			signalGroup(t.pgid, syscall.SIGKILL)
		}
	}()
}

// release lets go of the tree once the program has been waited for (nothing to let go of here)
func (t *procTree) release() {}
