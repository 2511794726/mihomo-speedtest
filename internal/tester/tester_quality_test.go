package tester

import "testing"

func intPtr(v int) *int {
	return &v
}

func TestComputeLatencyStats(t *testing.T) {
	median, jitter, loss := computeLatencyStats([]*int{intPtr(100), intPtr(120), intPtr(110)})
	if median == nil || *median != 110 {
		t.Fatalf("expected median 110, got %v", median)
	}
	if jitter == nil || *jitter != 15 {
		t.Fatalf("expected jitter 15, got %v", jitter)
	}
	if loss == nil || *loss != 0 {
		t.Fatalf("expected loss 0, got %v", loss)
	}

	median2, jitter2, loss2 := computeLatencyStats([]*int{intPtr(80), nil, intPtr(100)})
	if median2 == nil || *median2 != 100 {
		t.Fatalf("expected median 100, got %v", median2)
	}
	if jitter2 == nil || *jitter2 != 20 {
		t.Fatalf("expected jitter 20, got %v", jitter2)
	}
	if loss2 == nil || *loss2 != 33.3 {
		t.Fatalf("expected loss 33.3, got %v", loss2)
	}
}

func TestClassifyIPType(t *testing.T) {
	if got := classifyIPType(true, false); got != "datacenter" {
		t.Fatalf("expected datacenter, got %s", got)
	}
	if got := classifyIPType(false, true); got != "mobile" {
		t.Fatalf("expected mobile, got %s", got)
	}
	if got := classifyIPType(false, false); got != "residential" {
		t.Fatalf("expected residential, got %s", got)
	}
}

func TestPickFallbackTestURL(t *testing.T) {
	primary := "https://speed.cloudflare.com/__down?bytes=25000000"
	fb := pickFallbackTestURL(primary)
	if fb == "" || fb == primary {
		t.Fatalf("expected different fallback url, got %q", fb)
	}
}
