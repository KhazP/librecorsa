// Command release makes what a launcher release publishes (launcher/build.mjs and
// .github/workflows/release-launcher.yml run it):
//
//	go run ./tools/release keygen [--force]                     a new update key: writes update-key.pub, prints the private key
//	go run ./tools/release pubkeys <update-key.pub>             the public keys as a build embeds them (fails on a bad file)
//	go run ./tools/release pack --out <archive> <folder>        a .zip or .tar.gz holding the folder (by --out's name)
//	go run ./tools/release manifest --version <v> --base-url <url> --out <dir> <archive>...
//	                                                            launcher-latest.json for the archives, signed with
//	                                                            LAUNCHER_UPDATE_KEY when update-key.pub is there
//
// Run from launcher/. The private key never touches the disk: keygen prints it, manifest reads it from the environment.
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/librecorsa/librecorsa/launcher/internal/release"
)

// keyFile is the public key the launcher is built with, beside go.mod
const keyFile = "update-key.pub"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen(os.Args[2:])
	case "pubkeys":
		err = pubkeys(os.Args[2:])
	case "pack":
		err = pack(os.Args[2:])
	case "manifest":
		err = manifest(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: go run ./tools/release keygen|pubkeys|pack|manifest (see tools/release/main.go)")
	os.Exit(2)
}

func keygen(args []string) error {
	flags := flag.NewFlagSet("keygen", flag.ExitOnError)
	force := flags.Bool("force", false, "replace an existing "+keyFile)
	out := flags.String("out", keyFile, "where the public key goes")
	flags.Parse(args)
	if _, err := os.Stat(*out); err == nil && !*force {
		return fmt.Errorf("%s exists: releases already signed with its key couldn't be checked by launchers built with a new one. Pass --force to replace it anyway", *out)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	text := "# The launcher's update key (Ed25519, base64): a launcher built with it installs only an update whose\n" +
		"# manifest this key signed. Made by `npm run launcher:keygen`; its private half is the LAUNCHER_UPDATE_KEY secret.\n" +
		release.FormatPublicKey(pub) + "\n"
	if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Wrote the public key to %s: commit it.\n\n", *out)
	fmt.Fprintln(os.Stderr, "The private key, below, signs every release. Store it as the GitHub Actions secret LAUNCHER_UPDATE_KEY")
	fmt.Fprintln(os.Stderr, "(Settings > Secrets and variables > Actions > New repository secret), keep a copy offline, and nowhere else:")
	fmt.Fprintln(os.Stderr)
	fmt.Println(release.FormatPrivateKey(priv))
	return nil
}

func readKeys(file string) ([]ed25519.PublicKey, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	keys, err := release.ParsePublicKeys(string(b))
	if err == nil && len(keys) == 0 {
		err = fmt.Errorf("%s holds no key", file)
	}
	return keys, err
}

func pubkeys(args []string) error {
	if len(args) != 1 {
		return errors.New("pubkeys <update-key.pub>")
	}
	keys, err := readKeys(args[0])
	if err != nil {
		return err
	}
	list := make([]string, len(keys))
	for i, k := range keys {
		list[i] = release.FormatPublicKey(k)
	}
	fmt.Println(strings.Join(list, ","))
	return nil
}

// pack writes a folder into an archive whose one top entry is the folder, as the launcher's update reads it: folders
// and regular files only (a link anywhere fails the pack), each file executable when it was, in a fixed order
func pack(args []string) error {
	flags := flag.NewFlagSet("pack", flag.ExitOnError)
	out := flags.String("out", "", "the archive to write (.zip or .tar.gz)")
	flags.Parse(args)
	if *out == "" || flags.NArg() != 1 {
		return errors.New("pack --out <archive.zip|archive.tar.gz> <folder>")
	}
	src := filepath.Clean(flags.Arg(0))
	top := filepath.Base(src)
	type entry struct {
		name string
		info os.FileInfo
		path string
	}
	var entries []entry
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		name := top
		if rel != "." {
			name = path.Join(top, filepath.ToSlash(rel))
		}
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("%s is not a file or a folder (a link?): an update can't carry it", p)
		}
		entries = append(entries, entry{name, info, p})
		return nil
	})
	if err != nil {
		return err
	}
	slices.SortFunc(entries, func(a, b entry) int { return strings.Compare(a.name, b.name) })
	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(*out)
		}
	}()
	mode := func(info os.FileInfo) os.FileMode {
		if info.IsDir() {
			return fs0755 | os.ModeDir
		}
		if info.Mode().Perm()&0o111 != 0 {
			return fs0755
		}
		return 0o644
	}
	switch {
	case strings.HasSuffix(*out, ".zip"):
		zw := zip.NewWriter(f)
		for _, e := range entries {
			h := &zip.FileHeader{Name: e.name, Modified: e.info.ModTime().UTC().Truncate(time.Second)}
			h.SetMode(mode(e.info))
			if e.info.IsDir() {
				h.Name += "/"
				h.Method = zip.Store
				if _, err := zw.CreateHeader(h); err != nil {
					return err
				}
				continue
			}
			h.Method = zip.Deflate
			w, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			if err := copyFile(w, e.path); err != nil {
				return err
			}
		}
		if err := zw.Close(); err != nil {
			return err
		}
	case strings.HasSuffix(*out, ".tar.gz"):
		gz, _ := gzip.NewWriterLevel(f, gzip.BestCompression)
		tw := tar.NewWriter(gz)
		for _, e := range entries {
			h := &tar.Header{Name: e.name, Mode: int64(mode(e.info).Perm()), ModTime: e.info.ModTime().UTC().Truncate(time.Second), Format: tar.FormatPAX}
			if e.info.IsDir() {
				h.Typeflag, h.Name = tar.TypeDir, e.name+"/"
			} else {
				h.Typeflag, h.Size = tar.TypeReg, e.info.Size()
			}
			if err := tw.WriteHeader(h); err != nil {
				return err
			}
			if !e.info.IsDir() {
				if err := copyFile(tw, e.path); err != nil {
					return err
				}
			}
		}
		if err := tw.Close(); err != nil {
			return err
		}
		if err := gz.Close(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%s: the archive must be a .zip or a .tar.gz", *out)
	}
	if err := f.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

const fs0755 fs.FileMode = 0o755

func copyFile(w io.Writer, p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

// manifest writes launcher-latest.json for a release's archives (each found by its name, release.Target.ArchiveName)
// and, when the launcher is built with an update key (update-key.pub), its signature with the private key in
// LAUNCHER_UPDATE_KEY, which must be that key's other half. Without update-key.pub the manifest goes unsigned: the
// launchers built then only tell the player a newer release is out.
func manifest(args []string) error {
	flags := flag.NewFlagSet("manifest", flag.ExitOnError)
	version := flags.String("version", "", "the release's version")
	baseURL := flags.String("base-url", "", "where the release's files are downloaded from (https://…/releases/download/<tag>)")
	outDir := flags.String("out", ".", "where launcher-latest.json and its .sig go")
	keys := flags.String("keys", keyFile, "the public keys the launcher is built with")
	flags.Parse(args)
	if _, err := release.ParseVersion(*version); err != nil {
		return err
	}
	if !strings.HasPrefix(*baseURL, "https://") {
		return errors.New("--base-url must be an https:// address")
	}
	m := &release.Manifest{App: release.App, Format: release.Format, Version: *version, Released: time.Now().UTC().Format(time.RFC3339), Platforms: map[string]release.Asset{}}
	for _, file := range flags.Args() {
		name := filepath.Base(file)
		var target *release.Target
		for _, t := range release.Targets {
			if t.ArchiveName(*version) == name {
				target = &t
			}
		}
		if target == nil {
			return fmt.Errorf("%s is not a release archive for %s (LibreCorsa-%s-<platform>.zip/.tar.gz)", name, *version, *version)
		}
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		h := sha256.New()
		size, err := io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		m.Platforms[target.Platform()] = release.Asset{URL: strings.TrimSuffix(*baseURL, "/") + "/" + name, Size: size, SHA256: release.SHA256Hex(h.Sum(nil))}
	}
	if len(m.Platforms) == 0 {
		return errors.New("no archives given")
	}
	data, err := m.Encode()
	if err != nil {
		return err
	}
	if _, err := release.ParseManifest(data); err != nil {
		return err
	}
	// Signed first: a manifest is written only with its signature, or knowingly without one
	var sig []byte
	pub, err := readKeys(*keys)
	switch {
	case errors.Is(err, os.ErrNotExist):
		fmt.Fprintf(os.Stderr, "%s isn't there: %s goes unsigned, and launchers only say a newer release is out\n", *keys, release.ManifestName)
	case err != nil:
		return err
	default:
		secret := os.Getenv("LAUNCHER_UPDATE_KEY")
		if secret == "" {
			return fmt.Errorf("%s is there but LAUNCHER_UPDATE_KEY isn't set: launchers built with the key would refuse an unsigned manifest", *keys)
		}
		priv, err := release.ParsePrivateKey(secret)
		if err != nil {
			return fmt.Errorf("LAUNCHER_UPDATE_KEY: %w", err)
		}
		sig = release.Sign(priv, data)
		// The secret must be the committed key's other half, or every launcher would refuse the update
		if err := release.Verify(pub, data, sig); err != nil {
			return fmt.Errorf("LAUNCHER_UPDATE_KEY is not the private half of any key in %s", *keys)
		}
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(*outDir, release.ManifestName), data, 0o644); err != nil {
		return err
	}
	if sig == nil {
		return nil
	}
	if err := os.WriteFile(filepath.Join(*outDir, release.SignatureName), sig, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Signed %s for %d platforms\n", release.ManifestName, len(m.Platforms))
	return nil
}
