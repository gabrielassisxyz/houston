package main

import (
	"context"
	"io"
	"strings"
	"testing"
)

func dispatchForTest(t *testing.T, args []string) error {
	t.Helper()
	return dispatch(context.Background(), args, io.Discard, io.Discard)
}

func TestDamerauDistanceCatchesRealTypoClasses(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"note", "note", 0},
		{"noet", "note", 1},             // transposition
		{"hep", "help", 1},              // deletion
		{"helth", "health", 1},          // deletion
		{"--jsno", "--json", 1},         // transposition
		{"autnoomous", "autonomous", 1}, // adjacent swap
	}
	for _, c := range cases {
		if got := damerauDistance(c.a, c.b); got != c.want {
			t.Errorf("damerauDistance(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestSuggestThresholds(t *testing.T) {
	verbs := []string{"serve", "health", "preflight", "note", "graph", "search", "help"}
	if got := suggest("not", verbs); got != "note" {
		t.Errorf("suggest(not) = %q, want note", got)
	}
	if got := suggest("grahp", verbs); got != "graph" {
		t.Errorf("suggest(grahp) = %q, want graph", got)
	}
	if got := suggest("zzz", verbs); got != "" {
		t.Errorf("suggest(zzz) = %q, want no suggestion", got)
	}
	// Short inputs never get distance-2 guesses (too noisy).
	if got := suggest("pl", []string{"plan"}); got != "" {
		t.Errorf("suggest(pl) = %q, want no suggestion for short input", got)
	}
}

func TestDispatchUnknownCommandSuggests(t *testing.T) {
	err := dispatchForTest(t, []string{"not"})
	if err == nil || !strings.Contains(err.Error(), `did you mean "note"?`) {
		t.Fatalf("expected did-you-mean hint, got: %v", err)
	}
	if exitCode(err) != 2 {
		t.Errorf("typo'd command should be a usage error, got exit %d", exitCode(err))
	}
}

func TestDispatchUnknownFlagSuggests(t *testing.T) {
	err := dispatchForTest(t, []string{"--confg"})
	if err == nil || !strings.Contains(err.Error(), `did you mean "--config"?`) {
		t.Fatalf("expected flag did-you-mean hint, got: %v", err)
	}
}
