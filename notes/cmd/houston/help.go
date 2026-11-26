package main

// commandMeta is the single source of truth for the CLI surface: dispatch,
// help and (later) machine-readable contracts read from this table so they
// cannot drift from each other.
type commandMeta struct {
	Name    string
	Summary string
	Usage   string
	Details string
	Flags   []commandFlag
	// FlagsHeading overrides the "Flags:" line above the block. Kept from the
	// source so a verb that needs it does not lose the option.
	FlagsHeading string
	Subs         []commandMeta
}

// commandFlag is one flag, described once. The "Flags:" block of a help page is
// RENDERED from this - it is not written by hand into Details - so `--help` and
// a machine contract cannot disagree about what a flag is or takes.
//
// Value is the placeholder shown after the flag ("<n>", "<path>"); empty means
// the flag is a boolean. Description is one line; use Continuation for the rare
// flag whose explanation genuinely needs a second one.
type commandFlag struct {
	Name         string
	Alias        string
	Value        string
	Description  string
	Continuation []string
}

// commandTable lists houston's own verbs. serve, preflight and health carry
// their summaries here; note, graph and search reuse the command values their
// implementation files own so help and dispatch cannot disagree about the
// subcommands.
var commandTable = []commandMeta{
	{
		Name:    "serve",
		Summary: "Start the notes service",
		Usage:   "houston [--config <path>] serve [--addr <host:port>]",
		Details: `Starts the service on the configured vault and address.`,
	},
	{
		Name:    "preflight",
		Summary: "Report what the first index would change, writing nothing",
		Usage:   "houston [--config <path>] preflight [--json]",
		Details: `Walks the vault and prints one line per finding and a count per kind.`,
		Flags: []commandFlag{
			{Name: "--json", Description: `Emit {"errors","notices","counts","findings"} as one document`},
		},
	},
	{
		Name:    "health",
		Summary: "Print what a running service answers",
		Usage:   "houston [--config <path>] [--server <url>] health [--json]",
		Details: `The verb to reach for when something is wrong: it says whether a server is
reachable at the address this CLI would use, and which vault that server
has open, plus its readiness (indexing and file-report counts).`,
		Flags: []commandFlag{
			{Name: "--json", Description: `Emit the API's document verbatim`},
		},
	},
	noteCommand,
	graphCommand,
	searchCommand,
}

// commandNames returns the verb names in the table, for unknown-command hints.
func commandNames() []string {
	names := make([]string, 0, len(commandTable)+1)
	for _, c := range commandTable {
		names = append(names, c.Name)
	}
	names = append(names, "help")
	return names
}
