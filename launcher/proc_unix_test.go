//go:build !windows

package main

import (
	"context"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"
)

// signals records what is sent to process groups while a test runs, and sends it
func recordSignals(t *testing.T) func() []syscall.Signal {
	t.Helper()
	var mu sync.Mutex
	var sent []syscall.Signal
	was, wasGrace := signalGroup, killGrace
	signalGroup = func(pgid int, sig syscall.Signal) error {
		mu.Lock()
		sent = append(sent, sig)
		mu.Unlock()
		return syscall.Kill(-pgid, sig)
	}
	killGrace = 300 * time.Millisecond
	t.Cleanup(func() { signalGroup, killGrace = was, wasGrace })
	return func() []syscall.Signal {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(sent)
	}
}

// stopAfterStart runs a shell script with runProgram and stops it once it is under way
func stopAfterStart(t *testing.T, script string) error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	log := newRingLog(100)
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if lines, _ := log.tail(10); slices.Contains(lines, "started") {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
	}()
	return runProgram(ctx, log, t.TempDir(), nil, "/bin/sh", "-c", script)
}

// A program that ends when asked isn't killed afterwards: its group's id may be another's by then
func TestStopCallsOffTheKillOnceTheProgramEnds(t *testing.T) {
	sent := recordSignals(t)
	if err := stopAfterStart(t, "echo started; exec sleep 30"); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
	time.Sleep(3 * killGrace)
	if got := sent(); !slices.Equal(got, []syscall.Signal{syscall.SIGTERM}) {
		t.Errorf("sent %v, want only SIGTERM", got)
	}
}

// One that won't end is killed, with what it started
func TestStopKillsWhatWontEnd(t *testing.T) {
	sent := recordSignals(t)
	started := time.Now()
	if err := stopAfterStart(t, `trap "" TERM; echo started; sleep 30 & wait`); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
	if got := sent(); !slices.Equal(got, []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL}) {
		t.Errorf("sent %v, want SIGTERM then SIGKILL", got)
	}
	if took := time.Since(started); took > killGrace+3*time.Second {
		t.Errorf("stopping took %s", took)
	}
}
