package handlers

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestMonitoringProfileAcceptsEmbeddedIANATimezones(t *testing.T) {
	req := monitoringProfileReq{
		BusinessID: uuid.NewString(),
		Name:       "Cairo workday",
		Details: []monitoringDetailReq{{
			TrackingKey: "applications",
			TrackingVal: json.RawMessage(`true`),
			DaysOfWeek:  []int16{1, 2, 3, 4, 5},
			StartMinute: 9 * 60,
			EndMinute:   17 * 60,
			Timezone:    "Africa/Cairo",
		}},
	}

	input, message := req.input()
	if message != "" {
		t.Fatalf("valid Cairo timezone rejected: %s", message)
	}
	if got := input.Details[0].Timezone; got != "Africa/Cairo" {
		t.Fatalf("timezone = %q, want Africa/Cairo", got)
	}
}

func TestMonitoringProfileRejectsUnknownTimezone(t *testing.T) {
	req := monitoringProfileReq{
		BusinessID: uuid.NewString(),
		Name:       "Invalid zone",
		Details: []monitoringDetailReq{{
			TrackingKey: "applications",
			TrackingVal: json.RawMessage(`true`),
			DaysOfWeek:  []int16{1},
			StartMinute: 1,
			EndMinute:   2,
			Timezone:    "Mars/Olympus",
		}},
	}

	if _, message := req.input(); message != "timezone must be a valid IANA timezone" {
		t.Fatalf("message = %q", message)
	}
}
