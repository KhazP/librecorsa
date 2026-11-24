//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"unsafe"
)

// On Windows a program and what it starts are held in a Job Object that kills them all when it is closed, so a
// Python converter whose parent (uv) ended first is stopped with the rest, and nothing outlives the job. taskkill /T
// is the fallback when the job can't be made; it follows the parent links, which such an orphan has lost.

const (
	createNewProcessGroup = 0x00000200
	createNoWindow        = 0x08000000

	jobObjectExtendedLimitInfoClass = 9
	jobObjectLimitKillOnJobClose    = 0x00002000

	processSetQuota  = 0x0100
	processTerminate = 0x0001
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
)

// The Win32 structures SetInformationJobObject takes (winnt.h), laid out as the C compiler lays them out
type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// procTree is a program started with what it starts in turn
type procTree struct {
	cmd *exec.Cmd
	// job holds them all; 0 when it couldn't be made (then taskkill)
	job syscall.Handle
}

// startTree starts cmd with no console window of its own, in a process group of its own, and puts it in a new Job
// Object. What it starts joins the job by itself. (Go starts the program before it can be put in the job: what it
// starts in those first microseconds would be outside, which the converter's programs never do.)
func startTree(cmd *exec.Cmd) (*procTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | createNoWindow}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &procTree{cmd: cmd, job: newKillJob(cmd.Process.Pid)}, nil
}

// newKillJob makes a Job Object that kills its processes when closed, and puts pid in it; 0 when either fails
func newKillJob(pid int) syscall.Handle {
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return 0
	}
	job := syscall.Handle(h)
	var info jobObjectExtendedLimitInformation
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, _ := procSetInformationJobObject.Call(uintptr(job), jobObjectExtendedLimitInfoClass, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0
	}
	proc, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		syscall.CloseHandle(job)
		return 0
	}
	defer syscall.CloseHandle(proc)
	if ok, _, _ := procAssignProcessToJobObject.Call(uintptr(job), uintptr(proc)); ok == 0 {
		syscall.CloseHandle(job)
		return 0
	}
	return job
}

// stop ends the program and every process it started: the job's, at once; without a job, taskkill /T on its tree,
// with a fixed argv, the system's own copy, no window and a time limit. It is called before the program is waited
// for, so Go still holds its handle and its id can't have gone to another process.
func (t *procTree) stop(exited <-chan struct{}) {
	if t.job != 0 {
		procTerminateJobObject.Call(uintptr(t.job), 1)
		return
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	ctx, cancel := context.WithTimeout(context.Background(), killGrace)
	defer cancel()
	kill := exec.CommandContext(ctx, filepath.Join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(t.cmd.Process.Pid))
	kill.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
	if kill.Run() != nil {
		t.cmd.Process.Kill()
	}
}

// release closes the job once the program has been waited for, which ends anything it left running
func (t *procTree) release() {
	if t.job != 0 {
		syscall.CloseHandle(t.job)
		t.job = 0
	}
}
