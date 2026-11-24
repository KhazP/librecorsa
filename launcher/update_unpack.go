package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// Unpacking an update's archive, after its size and SHA-256 matched the signed manifest. It is held to the rules the
// converter's tools are (toolchain.go extractProgram), for every entry: a relative path with forward slashes and no
// `.`, `..` or empty segment, drive letter, backslash or control character (isSafeArchivePath), inside the one folder
// the archive is meant to hold, and only folders and regular files. An entry that breaks a rule (a link above all, or
// a name that would land outside) fails the whole update rather than being passed over: a release is made by
// tools/release pack, which writes nothing else. Everything is written through os.Root, each file once.

// Bounds on what an update may unpack to
const (
	maxUpdateEntries = 200_000
	maxUpdateBytes   = 16 << 30
)

// errUnsafeArchive is an archive holding an entry an update may not
var errUnsafeArchive = errors.New("the update's archive holds an entry it may not")

// unpackUpdate unpacks archive (format "zip" or "tar.gz") into destDir, which must not exist. Every entry must be
// inside the folder top.
func unpackUpdate(archive, format, top, destDir string) error {
	if err := os.Mkdir(destDir, 0o700); err != nil {
		return err
	}
	root, err := os.OpenRoot(destDir)
	if err != nil {
		return err
	}
	defer root.Close()
	u := &unpacker{root: root, top: top}
	switch format {
	case "zip":
		err = u.zip(archive)
	case "tar.gz":
		err = u.tarGz(archive)
	default:
		err = fmt.Errorf("unknown archive format %q", format)
	}
	if err == nil && !u.sawTop {
		err = fmt.Errorf("the update's archive doesn't hold %s/", top)
	}
	return err
}

type unpacker struct {
	root    *os.Root
	top     string
	entries int
	bytes   int64
	sawTop  bool
}

// check is an entry's name, cleaned of a folder's trailing slash, once it is found safe
func (u *unpacker) check(name string) (string, error) {
	u.entries++
	if u.entries > maxUpdateEntries {
		return "", fmt.Errorf("%w: more than %d entries", errUnsafeArchive, maxUpdateEntries)
	}
	if !isSafeArchivePath(name) {
		return "", fmt.Errorf("%w: %q", errUnsafeArchive, name)
	}
	clean := strings.TrimSuffix(name, "/")
	if clean != u.top && !strings.HasPrefix(clean, u.top+"/") {
		return "", fmt.Errorf("%w: %q is outside %s/", errUnsafeArchive, name, u.top)
	}
	u.sawTop = true
	return clean, nil
}

func (u *unpacker) dir(name string) error {
	if err := u.root.MkdirAll(name, 0o755); err != nil {
		return err
	}
	// A folder an earlier entry made as the parent of a file, or one named twice, is fine; a file of that name isn't
	info, err := u.root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %q is a file and a folder", errUnsafeArchive, name)
	}
	return nil
}

// file writes one regular file, executable when the archive says so; a name written twice fails
func (u *unpacker) file(name string, mode os.FileMode, r io.Reader) error {
	if dir := path.Dir(name); dir != "." {
		if err := u.dir(dir); err != nil {
			return err
		}
	}
	perm := os.FileMode(0o644)
	if mode.Perm()&0o111 != 0 {
		perm = 0o755
	}
	out, err := u.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%w: %q twice", errUnsafeArchive, name)
		}
		return err
	}
	left := maxUpdateBytes - u.bytes
	n, err := io.Copy(out, io.LimitReader(r, left+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	u.bytes += n
	if err == nil && n > left {
		err = fmt.Errorf("%w: more than %d bytes unpacked", errUnsafeArchive, int64(maxUpdateBytes))
	}
	return err
}

func (u *unpacker) zip(archive string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, zf := range zr.File {
		name, err := u.check(zf.Name)
		if err != nil {
			return err
		}
		mode := zf.Mode()
		switch {
		case mode.IsDir():
			if err := u.dir(name); err != nil {
				return err
			}
		case mode.IsRegular():
			rc, err := zf.Open()
			if err != nil {
				return err
			}
			err = u.file(name, mode, rc)
			rc.Close()
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: %q is a %s", errUnsafeArchive, zf.Name, mode.Type())
		}
	}
	return nil
}

func (u *unpacker) tarGz(archive string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			// Metadata for what follows (a pax global header), not a file
			continue
		}
		name, err := u.check(hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			err = u.dir(name)
		case tar.TypeReg:
			err = u.file(name, os.FileMode(hdr.Mode), tr)
		default:
			// Links (symbolic or hard), devices, FIFOs
			err = fmt.Errorf("%w: %q is of type %q", errUnsafeArchive, hdr.Name, hdr.Typeflag)
		}
		if err != nil {
			return err
		}
	}
}
