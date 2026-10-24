package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstanceLockKeepsInodeAcrossOwners(t *testing.T) {
	root := t.TempDir()
	first, err := acquireInstanceLock(root)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := acquireInstanceLock(root); err == nil {
		other.Close()
		t.Fatal("second writer accepted")
	}
	before, err := first.Stat()
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := acquireInstanceLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	after, err := os.Stat(filepath.Join(root, "personal-credentials", "instance.lock"))
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("lock inode changed")
	}
}
