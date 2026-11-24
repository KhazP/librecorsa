package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The answer to a start says the job runs, even when it ends at once: the panel watches the job by that answer
func TestStartAnswersRunningEvenWhenTheJobEndsAtOnce(t *testing.T) {
	js := newJobs(t.TempDir(), t.TempDir(), nil, newToolchain(t.TempDir(), "darwin", "arm64"))
	for i := range 200 {
		failed := i%2 == 1
		st, err := js.start("convert", "x", kindBlenderTrack, func(context.Context, *job) error {
			if failed {
				return errors.New("at once")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if st.State != jobRunning || st.ID != i+1 {
			t.Fatalf("start %d answered %+v", i, st)
		}
		<-js.last.done
		if end := js.status(); end.ID != st.ID || (failed && end.State != jobFailed) || (!failed && end.State != jobDone) {
			t.Fatalf("ended %+v", end)
		}
	}
}

func TestCopyImportTree(t *testing.T) {
	base := t.TempDir()
	importDir := filepath.Join(base, "import")
	writeFiles(t, importDir, map[string]string{
		"circuit/track.kn5":             "kn5",
		"circuit/ui/ui_track.json":      "{}",
		"circuit/ui/layout/outline.png": "png",
		"other/secret.txt":              secret,
	})
	os.MkdirAll(filepath.Join(importDir, "circuit", "empty"), 0o755)
	dest := t.TempDir()
	if err := copyImportTree(context.Background(), importDir, "circuit", dest); err != nil {
		t.Fatal(err)
	}
	var got []string
	filepath.WalkDir(filepath.Join(dest, "circuit"), func(p string, d fs.DirEntry, err error) error {
		rel, _ := filepath.Rel(dest, p)
		got = append(got, filepath.ToSlash(rel))
		info, _ := d.Info()
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s is %v: others may read or write it", rel, info.Mode().Perm())
		}
		return nil
	})
	want := []string{"circuit", "circuit/empty", "circuit/track.kn5", "circuit/ui", "circuit/ui/layout", "circuit/ui/layout/outline.png", "circuit/ui/ui_track.json"}
	if len(got) != len(want) {
		t.Fatalf("copied %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("copied %v, want %v", got, want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "circuit", "ui", "layout", "outline.png")); string(b) != "png" {
		t.Errorf("copied %q", b)
	}

	// A link in it, to a file outside or inside, stops the copy
	if err := os.Symlink(filepath.Join(importDir, "other", "secret.txt"), filepath.Join(importDir, "circuit", "ui", "skin.dds")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	dest2 := t.TempDir()
	if err := copyImportTree(context.Background(), importDir, "circuit", dest2); !errors.Is(err, errLinkInImport) {
		t.Errorf("a link: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dest2, "circuit", "ui", "skin.dds")); err == nil {
		t.Errorf("the link's file was copied: %q", b)
	}
	// And the folder itself as a link isn't opened
	os.Remove(filepath.Join(importDir, "circuit", "ui", "skin.dds"))
	os.Symlink(filepath.Join(importDir, "other"), filepath.Join(importDir, "linked"))
	if err := copyImportTree(context.Background(), importDir, "linked", t.TempDir()); err == nil {
		t.Error("a linked folder was copied")
	}
	// A stopped job stops the copy
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyImportTree(ctx, importDir, "circuit", t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}
