package handlers

import "testing"

func TestPlatformForCanonicalDownloads(t *testing.T) {
	tests := map[string]string{
		"EmployeeTracker-macOS.dmg":            "macos",
		"BiBoTracking-Windows-x64.msi":         "windows",
		"BiBoTracking-Windows-x64-Setup.exe":   "windows",
		"bibotracking-windows-x64-setup.EXE":   "windows",
		"BiBoTracking_1.5.2_x64-setup.exe":     "",
		"BiBoTracking_1.5.2_x64-setup.exe.sig": "",
		"BiBoTracking_1.5.2_x64.app.tar.gz":    "",
		"latest.json":                          "",
	}

	for filename, want := range tests {
		if got := platformFor(filename); got != want {
			t.Errorf("platformFor(%q) = %q, want %q", filename, got, want)
		}
	}
}
