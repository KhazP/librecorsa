package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "LibreCorsa", logFileName)
	l := &appLog{path: path}
	if err := l.open(); err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("x", 1000) + "\n"
	for range maxLogBytes/1000 + 10 {
		l.writeLine(line)
	}
	l.writeLine("the last line\n")
	l.f.Close()
	old, err := os.Stat(path + ".1")
	if err != nil || old.Size() < maxLogBytes {
		t.Fatalf("the rotated log: %v", err)
	}
	b, _ := os.ReadFile(path)
	if len(b) >= maxLogBytes || !strings.HasSuffix(string(b), "the last line\n") {
		t.Errorf("the log after rotating holds %d bytes", len(b))
	}
	// Large at the start: rotated before it is written to
	os.WriteFile(path, []byte(strings.Repeat(line, maxLogBytes/1000+1)), 0o600)
	l2 := &appLog{path: path}
	if err := l2.open(); err != nil {
		t.Fatal(err)
	}
	defer l2.f.Close()
	if l2.written != 0 {
		t.Errorf("a full log was appended to (%d bytes)", l2.written)
	}
}
