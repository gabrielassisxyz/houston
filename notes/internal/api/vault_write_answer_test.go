package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The link-suggestion step is not ported, so a write answers null for its
// three receipts - what kernl answers when it offers nothing - and the keys
// stay, because the CLI decodes the shape it decodes from kernl. The request
// carries the client header kernl offered suggestions to, so a suggestion
// step wired back in would show here.
func TestVaultWriteAnswersNullForTheSuggestionReceipts(t *testing.T) {
	mux := newTestRouter(t, newTestDeps(t, ""))

	body := "---\ntitle: Linked\n---\n\nA body that names [[Another note]].\n"
	req := httptest.NewRequest("POST", "/api/vault/file?path=linked.md", bytes.NewBufferString(body))
	req.Header.Set("X-Kernl-Client", "cli")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("write returned %d: %s", w.Code, w.Body.String())
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v: %s", err, w.Body.String())
	}
	if got := string(raw["status"]); got != `"saved"` {
		t.Errorf("status = %s, want \"saved\"", got)
	}
	for _, key := range []string{"suggestions", "accepted", "rejected"} {
		value, ok := raw[key]
		if !ok {
			t.Errorf("the answer lost the %q key: %s", key, w.Body.String())
			continue
		}
		if string(value) != "null" {
			t.Errorf("%s = %s, want null", key, value)
		}
	}
}
