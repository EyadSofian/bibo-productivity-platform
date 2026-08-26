package store

import (
	"testing"

	"github.com/google/uuid"
)

// register a device by syncing an empty batch, the same path a real agent takes
// on first contact. Returns the device id.
func registerDevice(t *testing.T, f syncFixture) string {
	t.Helper()
	if _, err := f.store.SyncBatch(f.ctx, f.userID, f.bizID, f.deviceID, nil, nil, nil, nil); err != nil {
		t.Fatalf("register device: %v", err)
	}
	return f.deviceID
}

func TestListDevicesReturnsRegistered(t *testing.T) {
	f := newSyncFixture(t)
	id := registerDevice(t, f)

	devices, err := f.store.ListDevices(f.ctx, f.userID, f.bizID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(devices) != 1 {
		t.Fatalf("want 1 device, got %d", len(devices))
	}
	d := devices[0]
	if d.ID != id {
		t.Errorf("id = %s, want %s", d.ID, id)
	}
	if !d.MonitoringEnabled {
		t.Error("a new device should default to monitoring enabled")
	}
	if d.BusinessID == nil || *d.BusinessID != f.bizID {
		t.Errorf("business_id = %v, want %s", d.BusinessID, f.bizID)
	}
	// The inventory joins the owning user for display.
	if d.UserDisplayName != "Display Name" {
		t.Errorf("display name = %q, want the joined user name", d.UserDisplayName)
	}
}

// The security-critical property: one owner must never see, nor be able to
// change, another owner's devices — even by naming the right ids.
func TestListDevicesIsTenantScoped(t *testing.T) {
	f := newSyncFixture(t)
	registerDevice(t, f)

	// A second owner with their own business and no devices.
	other := mustUser(t, f.ctx, f.store, "intruder@example.com", "")
	otherBiz, err := f.store.CreateBusiness(f.ctx, other.ID, "Other", "team")
	if err != nil {
		t.Fatalf("create other business: %v", err)
	}

	// Naming the first owner's business as the intruder returns nothing.
	devices, err := f.store.ListDevices(f.ctx, other.ID, f.bizID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(devices) != 0 {
		t.Fatalf("cross-tenant list leaked %d device(s)", len(devices))
	}

	// And the intruder's own (empty) business is genuinely empty, proving the
	// previous assertion was not a false pass from a broken query.
	devices, err = f.store.ListDevices(f.ctx, other.ID, otherBiz.ID)
	if err != nil {
		t.Fatalf("list own: %v", err)
	}
	if len(devices) != 0 {
		t.Fatalf("intruder's own business should have no devices, got %d", len(devices))
	}
}

func TestSetDeviceMonitoringTogglesAndStamps(t *testing.T) {
	f := newSyncFixture(t)
	id := registerDevice(t, f)

	off, err := f.store.SetDeviceMonitoring(f.ctx, f.userID, id, false)
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if off.MonitoringEnabled {
		t.Error("device should be disabled")
	}
	if off.DisabledAt == nil {
		t.Error("disabled_at should be stamped when monitoring is turned off")
	}

	on, err := f.store.SetDeviceMonitoring(f.ctx, f.userID, id, true)
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if !on.MonitoringEnabled {
		t.Error("device should be enabled")
	}
	if on.DisabledAt != nil {
		t.Error("disabled_at should be cleared when monitoring is turned back on")
	}
}

// A caller must not be able to disable monitoring on a device in a business they
// do not own; the attempt must be indistinguishable from a missing device.
func TestSetDeviceMonitoringIsTenantScoped(t *testing.T) {
	f := newSyncFixture(t)
	id := registerDevice(t, f)

	intruder := mustUser(t, f.ctx, f.store, "intruder@example.com", "")
	if _, err := f.store.CreateBusiness(f.ctx, intruder.ID, "Other", "team"); err != nil {
		t.Fatalf("create business: %v", err)
	}

	_, err := f.store.SetDeviceMonitoring(f.ctx, intruder.ID, id, false)
	if err != ErrNotFound {
		t.Fatalf("cross-tenant disable: err = %v, want ErrNotFound", err)
	}

	// The real owner's device is untouched by the failed attempt.
	devices, _ := f.store.ListDevices(f.ctx, f.userID, f.bizID)
	if len(devices) != 1 || !devices[0].MonitoringEnabled {
		t.Fatal("a cross-tenant attempt must not have changed the device")
	}
}

func TestSetDeviceMonitoringUnknownDevice(t *testing.T) {
	f := newSyncFixture(t)
	_, err := f.store.SetDeviceMonitoring(f.ctx, f.userID, uuid.NewString(), false)
	if err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// The whole point of the flag: a disabled device's data is dropped, but the
// device stays alive in the inventory.
func TestSyncDropsDataWhenMonitoringDisabled(t *testing.T) {
	f := newSyncFixture(t)
	id := registerDevice(t, f)

	if _, err := f.store.SetDeviceMonitoring(f.ctx, f.userID, id, false); err != nil {
		t.Fatalf("disable: %v", err)
	}

	before := f.count(t, "activity_samples")
	res, err := f.store.SyncBatch(f.ctx, f.userID, f.bizID, id, nil,
		[]ActivityRow{activity(uuid.NewString(), "Code", 60, 1)}, nil, nil)
	if err != nil {
		t.Fatalf("sync while disabled: %v", err)
	}

	if res.MonitoringEnabled {
		t.Error("result should report monitoring disabled")
	}
	if res.Dropped != 1 {
		t.Errorf("dropped = %d, want 1", res.Dropped)
	}
	if got := f.count(t, "activity_samples"); got != before {
		t.Errorf("activity rows changed from %d to %d — data was ingested despite the device being disabled", before, got)
	}

	// Re-enabling resumes ingestion.
	if _, err := f.store.SetDeviceMonitoring(f.ctx, f.userID, id, true); err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	res, err = f.store.SyncBatch(f.ctx, f.userID, f.bizID, id, nil,
		[]ActivityRow{activity(uuid.NewString(), "Code", 60, 1)}, nil, nil)
	if err != nil {
		t.Fatalf("sync after re-enable: %v", err)
	}
	if !res.MonitoringEnabled || res.Dropped != 0 {
		t.Errorf("after re-enable: enabled=%v dropped=%d, want true/0", res.MonitoringEnabled, res.Dropped)
	}
	if got := f.count(t, "activity_samples"); got != before+1 {
		t.Errorf("activity = %d, want %d after re-enabled sync", got, before+1)
	}
}
