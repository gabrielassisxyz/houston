// Package frontmatter reads YAML frontmatter from Markdown-style files and
// provides safe, byte-level UUID injection without disturbing any other content.
//
// Design principles:
//   - Read: extract typed values via gopkg.in/yaml.v3 (id, title, author, origin, kind, tags, refs).
//   - Write: NEVER marshal. Inject surgically at the byte level.
//   - Preserve BOM, line endings (LF/CRLF), comments, blank lines, and key order.
//   - Malformed YAML: detect, do NOT inject, return recoverable error; leave bytes intact.
package frontmatter

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
)

// Frontmatter holds parsed YAML frontmatter values.
type Frontmatter struct {
	ID         string     `yaml:"id"`
	Title      string     `yaml:"title"`
	Author     string     `yaml:"author"`
	Origin     string     `yaml:"origin"`
	Permission string     `yaml:"permission"`
	Kind       string     `yaml:"kind"`
	Tags       StringList `yaml:"tags"`
	Refs       StringList `yaml:"refs"`
}

// Note kinds. Anything else, or nothing, counts as KindNota.
const (
	KindPlano         = "plano"
	KindImplementacao = "implementacao"
	KindEvidencia     = "evidencia"
	KindNota          = "nota"
)

// NormalizeKind trims and lower-cases s and maps it onto the four kinds.
// Anything else, including the empty string, counts as nota.
func NormalizeKind(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case KindPlano:
		return KindPlano
	case KindImplementacao:
		return KindImplementacao
	case KindEvidencia:
		return KindEvidencia
	case KindNota:
		return KindNota
	default:
		return KindNota
	}
}

// StringList is the single YAML list type tags and refs share. It accepts:
//   - null or empty as an empty list;
//   - a single scalar, string or number, as a one-item list of its trimmed text;
//   - a sequence of scalars as the list, blank items dropped after trimming.
//
// A mapping or a nested sequence is a parse error.
type StringList []string

// UnmarshalYAML implements yaml.Unmarshaler for StringList.
func (s *StringList) UnmarshalYAML(value *yaml.Node) error {
	switch value.Kind {
	case yaml.ScalarNode:
		if value.Tag == "!!null" {
			*s = nil
			return nil
		}
		trimmed := strings.TrimSpace(value.Value)
		if trimmed == "" {
			*s = nil
			return nil
		}
		*s = StringList{trimmed}
		return nil
	case yaml.SequenceNode:
		var out StringList
		for _, item := range value.Content {
			switch item.Kind {
			case yaml.ScalarNode:
				if item.Tag == "!!null" {
					continue
				}
				trimmed := strings.TrimSpace(item.Value)
				if trimmed == "" {
					continue
				}
				out = append(out, trimmed)
			default:
				return fmt.Errorf("frontmatter: list item must be a scalar, got %s", yamlKindName(item.Kind))
			}
		}
		*s = out
		return nil
	case yaml.AliasNode:
		return fmt.Errorf("frontmatter: list must not be an alias")
	default:
		return fmt.Errorf("frontmatter: expected a scalar or a list, got %s", yamlKindName(value.Kind))
	}
}

func yamlKindName(k yaml.Kind) string {
	switch k {
	case yaml.DocumentNode:
		return "document"
	case yaml.SequenceNode:
		return "sequence"
	case yaml.MappingNode:
		return "mapping"
	case yaml.ScalarNode:
		return "scalar"
	case yaml.AliasNode:
		return "alias"
	default:
		return "unknown"
	}
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
	fm.Kind = NormalizeKind(fm.Kind)
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
