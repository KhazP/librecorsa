//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"
)

func TestErrorDialogCommand(t *testing.T) {
	msg := `Port 47826 is "taken"; <b>bold</b> & 'quotes'`
	name, args := errorDialogCommand("darwin", msg, nil)
	if name != "/usr/bin/osascript" || args[len(args)-1] != msg || strings.Contains(strings.Join(args[:len(args)-1], " "), "taken") {
		t.Errorf("darwin: the message must be an argument of its own: %s %q", name, args)
	}
	zenity := func(n string) (string, error) {
		if n == "zenity" {
			return "/usr/bin/zenity", nil
		}
		return "", os.ErrNotExist
	}
	if name, args := errorDialogCommand("linux", msg, zenity); name != "/usr/bin/zenity" || !strings.Contains(strings.Join(args, " "), "--no-markup") {
		t.Errorf("zenity: %s %q", name, args)
	}
	kdialog := func(n string) (string, error) {
		if n == "kdialog" {
			return "/usr/bin/kdialog", nil
		}
		return "", os.ErrNotExist
	}
	if name, args := errorDialogCommand("linux", msg, kdialog); name != "/usr/bin/kdialog" || args[len(args)-1] != msg {
		t.Errorf("kdialog: %s %q", name, args)
	}
	none := func(string) (string, error) { return "", os.ErrNotExist }
	if name, _ := errorDialogCommand("linux", msg, none); name != "" {
		t.Errorf("none: %s", name)
	}
}
