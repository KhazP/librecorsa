package main

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// The launcher's log. Started from the Finder, the Start menu or a file manager it has no terminal, so what it says
// (fmt.Print* and os.Stderr throughout) also goes, line by line with the time, to <config>/LibreCorsa/launcher.log.
// The log is kept small: past maxLogBytes it moves to launcher.log.1 (one older log kept) and starts again. A crash's
// report goes there too.

// maxLogBytes is how large the log grows before it is rotated
const maxLogBytes = 1 << 20

// logFileName is the log's name in the config folder
const logFileName = "launcher.log"

// appLog tees the process's standard output and error into the log file
type appLog struct {
	path    string
	mu      sync.Mutex
	f       *os.File
	written int64

	stdout, stderr *os.File // the originals, which still get everything
	wOut, wErr     *os.File // the pipes os.Stdout and os.Stderr write to now
	done           sync.WaitGroup
}

// currentLog is the running log, closed by closeLog before the process exits
var currentLog atomic.Pointer[appLog]

// logPath is where the launcher's log is
func logPath() string { return filepath.Join(configDir(), logFileName) }

// startLog starts teeing standard output and error into the log. A log that can't be opened leaves them as they are.
func startLog(path string) {
	l := &appLog{path: path}
	if err := l.open(); err != nil {
		return
	}
	rOut, wOut, err := os.Pipe()
	if err != nil {
		l.f.Close()
		return
	}
	rErr, wErr, err := os.Pipe()
	if err != nil {
		rOut.Close()
		wOut.Close()
		l.f.Close()
		return
	}
	l.stdout, l.stderr, l.wOut, l.wErr = os.Stdout, os.Stderr, wOut, wErr
	os.Stdout, os.Stderr = wOut, wErr
	currentLog.Store(l)
	// A crash's report (an unrecovered panic, a fatal runtime error) is written straight to the file
	debug.SetCrashOutput(l.f, debug.CrashOptions{})
	l.done.Add(2)
	go l.copy(rOut, l.stdout)
	go l.copy(rErr, l.stderr)
}

// open opens the log for appending, rotating it first when it is already large
func (l *appLog) open() error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(l.path); err == nil && info.Size() >= maxLogBytes {
		os.Rename(l.path, l.path+".1")
	}
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.written = f, info.Size()
	return nil
}

// copy passes each line read from r to the original stream as it is, and to the file with the time before it
func (l *appLog) copy(r *os.File, orig *os.File) {
	defer l.done.Done()
	defer r.Close()
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			if orig != nil {
				// A window app's standard streams may lead nowhere: what can't be written there is in the file
				io.WriteString(orig, line)
			}
			l.writeLine(line)
		}
		if err != nil {
			return
		}
	}
}

func (l *appLog) writeLine(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	if line[len(line)-1] != '\n' {
		line += "\n"
	}
	n, _ := io.WriteString(l.f, time.Now().Format("2006-01-02 15:04:05 ")+line)
	l.written += int64(n)
	if l.written >= maxLogBytes {
		l.rotate()
	}
}

// rotate moves a full log aside and starts a new one (l.mu held)
func (l *appLog) rotate() {
	l.f.Close()
	l.f = nil
	os.Rename(l.path, l.path+".1")
	if f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
		l.f, l.written = f, 0
		if currentLog.Load() == l {
			debug.SetCrashOutput(f, debug.CrashOptions{})
		}
	}
}

// closeLog writes out what is still on its way to the log and puts the standard streams back
func closeLog() {
	l := currentLog.Swap(nil)
	if l == nil {
		return
	}
	os.Stdout, os.Stderr = l.stdout, l.stderr
	l.wOut.Close()
	l.wErr.Close()
	waited := make(chan struct{})
	go func() {
		l.done.Wait()
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(time.Second):
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}
