package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFinalOutputNamesAndPreviewPaths(t *testing.T) {
	for _, name := range []string{"", " ", ".", "..", "a/b", "a\\b", "a\x00b", "a\nb"} {
		if outputName(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"final.txt", "最终截图.png", "-result.pdf"} {
		if !outputName(name) {
			t.Fatal(name)
		}
	}
	directory, err := os.MkdirTemp("", "ruukoto-output-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	filename := filepath.Join(directory, "final.txt")
	if !outputPreviewPath(filename, "final.txt") {
		t.Fatal("host temporary output rejected")
	}
	for _, bad := range []string{"/private/final.txt", filepath.Join(directory, "other.txt"), filepath.Join(directory, "nested", "final.txt"), "relative/final.txt"} {
		if outputPreviewPath(bad, "final.txt") {
			t.Fatal(bad)
		}
	}
	var previews outputPreviews
	if err := previews.stop(123); err != nil {
		t.Fatal(err)
	}
	if _, err := previews.open("/private/final.txt", "final.txt"); err == nil {
		t.Fatal("arbitrary local preview accepted")
	}
}
