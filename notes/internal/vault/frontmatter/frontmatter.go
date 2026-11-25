// Package frontmatter reads YAML frontmatter from Markdown-style files and
// provides safe, byte-level UUID injection without disturbing any other content.
//
// Design principles:
//   - Read: extract typed values via gopkg.in/yaml.v3 (id, title, author, origin, tags).
//   - Write: NEVER marshal. Inject surgically at the byte level.
//   - Preserve BOM, line endings (LF/CRLF), comments, blank lines, and key order.
//   - Malformed YAML: detect, do NOT inject, return recoverable error; leave bytes intact.
package frontmatter

import (
	"fmt"

	"gopkg.in/yaml.v3"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
)

// Frontmatter holds parsed YAML frontmatter values.
type Frontmatter struct {
	ID         string   `yaml:"id"`
	Title      string   `yaml:"title"`
	Author     string   `yaml:"author"`
	Origin     string   `yaml:"origin"`
	Permission string   `yaml:"permission"`
	Tags       []string `yaml:"tags"`
}

// Parse extracts frontmatter values from raw bytes.
// It looks for a YAML block between an opening "---" fence on the first line
// and the next "---" fence line, as vaultfile.ScanFrontmatter defines them. If
// no frontmatter block is found, an empty Frontmatter is returned with no
// error - callers should treat absent frontmatter as a valid state.
func Parse(raw []byte) (*Frontmatter, error) {
	block, err := extractBlock(raw)
	if err != nil {
		return nil, err
	}
	if block == nil {
		return &Frontmatter{}, nil
	}

	var fm Frontmatter
	if err := yaml.Unmarshal(block, &fm); err != nil {
		return nil, fmt.Errorf("frontmatter: yaml parse error: %w", err)
	}
	return &fm, nil
}

// extractBlock returns the YAML between the "---" fences, or nil when the
// file has no frontmatter block. A block that is opened and never closed is
// refused rather than read: guessing where it ends could take the body for
// YAML, and an id injected into a guess is written into the user's note.
func extractBlock(raw []byte) ([]byte, error) {
	fm := vaultfile.ScanFrontmatter(raw)
	switch fm.State {
	case vaultfile.ClosedBlock:
		return raw[fm.Start:fm.Close], nil
	case vaultfile.UnclosedBlock:
		return nil, fmt.Errorf("frontmatter: unterminated frontmatter block")
	}
	return nil, nil
}
