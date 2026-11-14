package tester

import (
	"context"
	"sync"
	"time"
)

// BandwidthLimiter 提供线程安全的全局并发总速率统计与触顶拥塞窗口标记（不阻塞单线程下载，避免低估高速节点）。
type BandwidthLimiter struct {
	mu              sync.Mutex
	maxMBps         float64
	throttled       bool
	lastCongestedAt time.Time

	windowStart time.Time
	windowBytes int64
	totalBytes  int64
	lastMBps    float64
}

func NewBandwidthLimiter(maxMBps float64) *BandwidthLimiter {
	return &BandwidthLimiter{
		maxMBps:     maxMBps,
		windowStart: time.Now(),
	}
}

func (b *BandwidthLimiter) Consume(_ context.Context, n int) error {
	if b == nil || n <= 0 {
		return nil
	}

	b.mu.Lock()
	b.windowBytes += int64(n)
	b.totalBytes += int64(n)
	now := time.Now()
	if elapsed := now.Sub(b.windowStart).Seconds(); elapsed >= 0.6 {
		cur := float64(b.windowBytes) / (1024 * 1024) / elapsed
		b.lastMBps = cur
		b.windowStart = now
		b.windowBytes = 0
		if b.maxMBps > 0 && cur >= b.maxMBps*0.92 {
			b.throttled = true
			b.lastCongestedAt = now
		}
	}
	b.mu.Unlock()
	return nil
}

func (b *BandwidthLimiter) MarkCongested() {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.throttled = true
	b.lastCongestedAt = time.Now()
	b.mu.Unlock()
}

func (b *BandwidthLimiter) ClearThrottled() {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.throttled = false
	b.mu.Unlock()
}

func (b *BandwidthLimiter) WasCongestedBetween(start, end time.Time) bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	at := b.lastCongestedAt
	b.mu.Unlock()
	if at.IsZero() {
		return false
	}
	return !at.Before(start) && !at.After(end.Add(300*time.Millisecond))
}

func (b *BandwidthLimiter) TotalBytes() int64 {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.totalBytes
}

func (b *BandwidthLimiter) Snapshot() (currentMBps float64, throttled bool) {
	if b == nil {
		return 0, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if elapsed := now.Sub(b.windowStart).Seconds(); elapsed >= 0.3 {
		cur := float64(b.windowBytes) / (1024 * 1024) / elapsed
		if b.maxMBps > 0 && cur >= b.maxMBps*0.92 {
			b.throttled = true
			b.lastCongestedAt = now
		}
		return round2(cur), b.throttled
	}
	return round2(b.lastMBps), b.throttled
}
