package main

import (
	"bufio"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Where a release keeps things. The player's own folders (mods, and circuits and cars to convert) are in
// Documents/LibreCorsa on every system, where people look for them; the program's own files (the game, the converter)
// sit beside the launcher, or in Contents/Resources inside the macOS app; the browser profile, the converter's
// toolchain, the update and the log go in the per-user config folder (profileRoot).

// appFolderName is the folder in Documents and in the config folder
const appFolderName = "LibreCorsa"

// programDir is the folder holding the program's own files: the launcher's own folder, or the app bundle's
// Contents/Resources when it runs from Contents/MacOS ("" if unknown)
func programDir() string {
	return resourcesFor(executableDir())
}

// resourcesFor maps the launcher's folder to where its files are
func resourcesFor(exeDir string) string {
	if bundle := appBundleOf(exeDir); bundle != "" {
		return filepath.Join(bundle, "Contents", "Resources")
	}
	return exeDir
}

// appBundleOf is the macOS app bundle (…/LibreCorsa.app) whose Contents/MacOS is exeDir, or ""
func appBundleOf(exeDir string) string {
	if exeDir == "" || filepath.Base(exeDir) != "MacOS" {
		return ""
	}
	contents := filepath.Dir(exeDir)
	bundle := filepath.Dir(contents)
	if filepath.Base(contents) != "Contents" || !strings.HasSuffix(strings.ToLower(bundle), ".app") {
		return ""
	}
	return bundle
}

// dropFinderArgs removes the -psn_… argument older macOS versions add when an app is opened from the Finder, which
// the flags would refuse
func dropFinderArgs(args []string) []string {
	out := args[:0:0]
	for i, a := range args {
		if i > 0 && strings.HasPrefix(a, "-psn_") {
			continue
		}
		out = append(out, a)
	}
	return out
}

// configDir is <config>/LibreCorsa: the log, the update, beside the browser profile and the toolchain
func configDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(profileRoot(runtime.GOOS, home), appFolderName)
}

// documentsDir is the player's Documents folder: Windows' known folder (it may be redirected, to OneDrive or a
// network share), XDG_DOCUMENTS_DIR on Linux, ~/Documents on macOS and when those can't be read
func documentsDir() string {
	if dir, err := knownDocumentsDir(); err == nil && dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Documents")
}

// xdgDocumentsDir reads XDG_DOCUMENTS_DIR from user-dirs.dirs (xdg-user-dirs), the folder a Linux desktop names
// Documents in the player's language. The value is "$HOME/<path>" or an absolute path; "$HOME" alone means the
// folder is switched off. "" when the file doesn't say.
func xdgDocumentsDir(r io.Reader, home string) string {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		rest, ok := strings.CutPrefix(line, "XDG_DOCUMENTS_DIR=")
		if !ok {
			continue
		}
		value, ok := unquoteShell(strings.TrimSpace(rest))
		if !ok {
			return ""
		}
		switch {
		case value == "$HOME" || value == "$HOME/":
			return ""
		case strings.HasPrefix(value, "$HOME/"):
			if home == "" {
				return ""
			}
			return filepath.Join(home, filepath.FromSlash(value[len("$HOME/"):]))
		case strings.HasPrefix(value, "/"):
			return filepath.Clean(value)
		}
		return ""
	}
	return ""
}

// unquoteShell undoes the double quotes xdg-user-dirs writes a value in (a backslash escapes the next character)
func unquoteShell(s string) (string, bool) {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return "", false
	}
	var b strings.Builder
	in := s[1 : len(s)-1]
	for i := 0; i < len(in); i++ {
		c := in[i]
		if c == '\\' && i+1 < len(in) {
			i++
			c = in[i]
		} else if c == '"' {
			return "", false
		}
		b.WriteByte(c)
	}
	return b.String(), true
}

// linuxDocumentsDir is XDG_DOCUMENTS_DIR from $XDG_CONFIG_HOME/user-dirs.dirs (~/.config by default)
func linuxDocumentsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" || !filepath.IsAbs(config) {
		config = filepath.Join(home, ".config")
	}
	f, err := os.Open(filepath.Join(config, "user-dirs.dirs"))
	if err != nil {
		return "", err
	}
	defer f.Close()
	if dir := xdgDocumentsDir(io.LimitReader(f, 64<<10), home); dir != "" {
		return dir, nil
	}
	return "", errors.New("user-dirs.dirs names no Documents folder")
}

// playerFolder is one of the player's folders: the flag's, else in a clone the one beside the source (inClone,
// relative to the working directory), else <Documents>/LibreCorsa/<name>
func playerFolder(flagValue, name, inClone string, clone bool) (string, error) {
	switch {
	case flagValue != "":
		return filepath.Abs(flagValue)
	case clone:
		return filepath.Abs(inClone)
	default:
		return filepath.Join(documentsDir(), appFolderName, name), nil
	}
}

// modsReadme is written into a new mods folder
//
//go:embed mods-readme.txt
var modsReadme string

// makeModsDir creates the mods folder, with a README on what goes in it, if it isn't there
func makeModsDir(dir string) error {
	if _, err := os.Stat(dir); err == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	text := modsReadme
	if runtime.GOOS == "windows" {
		text = strings.ReplaceAll(text, "\n", "\r\n")
	}
	return os.WriteFile(filepath.Join(dir, "README.txt"), []byte(text), 0o644)
}

// writableConverter is the converter folder to run from. The converter writes its working copies inside its own
// folder (converter.json "work"), which in the macOS app is inside the signed, maybe read-only, bundle: there it is
// copied once per release into <config>/LibreCorsa/converter, and run from the copy. Elsewhere it runs where it is.
func writableConverter(dir string) string {
	exeBundle := appBundleOf(executableDir())
	if exeBundle == "" || !isWithin(dir, exeBundle) {
		return dir
	}
	copyDir := filepath.Join(configDir(), "converter")
	if err := mirrorConverter(dir, copyDir); err != nil {
		fmt.Fprintf(os.Stderr, "Couldn't copy the converter out of the app (%v): converting may not work\n", err)
		return dir
	}
	return copyDir
}

// isWithin reports whether p is dir or inside it
func isWithin(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// mirrorConverter copies the converter in src to dst unless dst already holds this one (a stamp of converter.json
// and the launcher's version): its folders and regular files only
func mirrorConverter(src, dst string) error {
	manifest, err := os.ReadFile(filepath.Join(src, "converter.json"))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(append(append([]byte(version), 0), manifest...))
	stamp := hex.EncodeToString(sum[:])
	stampFile := filepath.Join(dst, ".librecorsa-stamp")
	if b, err := os.ReadFile(stampFile); err == nil && strings.TrimSpace(string(b)) == stamp {
		return nil
	}
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := copyTree(src, dst); err != nil {
		return err
	}
	return os.WriteFile(stampFile, []byte(stamp+"\n"), 0o644)
}

// copyTree copies a folder's folders and regular files (links and anything else are left behind) to dst, which
// must not exist, keeping each file's executable bit
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		switch {
		case info.IsDir():
			return os.MkdirAll(target, 0o755)
		case info.Mode().IsRegular():
			mode := os.FileMode(0o644)
			if info.Mode().Perm()&0o111 != 0 {
				mode = 0o755
			}
			return copyRegular(p, target, mode)
		}
		return nil
	})
}

func copyRegular(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}
