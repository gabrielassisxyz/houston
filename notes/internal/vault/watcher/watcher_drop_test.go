package watcher

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Nothing drains the buffer while the first index runs. A coalescer that
// finds it full drops its event and records the loss instead of blocking: the
// fake scheduler runs callbacks on the caller's goroutine, so a blocking send
// would hang fireDue itself.
func TestEmitNeverBlocksAndRecordsTheDrop(t *testing.T) {
	sched := &fakeScheduler{}
	w, raw := startInjected(t, sched)
	defer w.Stop()

	const capacity, extra = 256, 20
	for i := 0; i < capacity+extra; i++ {
		raw <- fsnotify.Event{Name: under(w, fmt.Sprintf("note-%03d.md", i)), Op: fsnotify.Write}
		if i%32 == 31 {
			feed(t, sched, raw, i+1)
		}
	}
	feed(t, sched, raw, capacity+extra)

	if w.TakeDropped() {
		t.Fatal("dropped is set before any event was emitted")
	}
	fired := make(chan int, 1)
	go func() { fired <- sched.fireDue() }()
	select {
	case n := <-fired:
		if n != capacity+extra {
			t.Fatalf("%d coalescers fired, want %d", n, capacity+extra)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a coalescer blocked sending into the full buffer")
	}

	if got := len(drain(w)); got != capacity {
		t.Errorf("%d events buffered, want the buffer's %d", got, capacity)
	}
	if !w.TakeDropped() {
		t.Error("the dropped events were not recorded")
	}
	if w.TakeDropped() {
		t.Error("TakeDropped did not clear the flag")
	}
}

// The kernel's own queue overflowing is a loss too.
func TestKernelQueueOverflowRecordsTheDrop(t *testing.T) {
	sched := &fakeScheduler{}
	raw := make(chan fsnotify.Event, 1)
	errs := make(chan error, 1)
	w := newWithSources(t.TempDir(), Config{CoalesceWindow: time.Hour}, sched, raw, errs, &fakeBackend{})
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer w.Stop()

	errs <- fsnotify.ErrEventOverflow
	deadline := time.Now().Add(5 * time.Second)
	for !w.TakeDropped() {
		if time.Now().After(deadline) {
			t.Fatal("an inotify queue overflow was only logged, not recorded as dropped")
		}
		time.Sleep(time.Millisecond)
	}
	if w.TakeDropped() {
		t.Error("TakeDropped did not clear the flag")
	}
}
