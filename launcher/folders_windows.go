//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// shell32 and ole32 are KnownDLLs: Windows loads them from System32 whatever the search path holds
var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
)

// folderIDDocuments is FOLDERID_Documents ({FDD39AD0-238F-46AF-ADB4-6C85480369C7}, KnownFolders.h)
var folderIDDocuments = syscall.GUID{
	Data1: 0xFDD39AD0, Data2: 0x238F, Data3: 0x46AF,
	Data4: [8]byte{0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7},
}

// knownDocumentsDir is the Documents known folder, wherever the player (or their organisation, or OneDrive) moved it
func knownDocumentsDir() (string, error) {
	if err := procSHGetKnownFolderPath.Find(); err != nil {
		return "", err
	}
	var p *uint16
	hr, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderIDDocuments)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if p != nil {
		defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	}
	if hr != 0 || p == nil {
		return "", fmt.Errorf("SHGetKnownFolderPath: HRESULT %#x", uint32(hr))
	}
	return utf16PtrToString(p), nil
}

// utf16PtrToString reads a NUL-terminated UTF-16 string Windows returned
func utf16PtrToString(p *uint16) string {
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0 && n < 32768; n++ {
		ptr = unsafe.Add(ptr, 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}
