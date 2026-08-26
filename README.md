# Larvae for VS Code

Lint diagnostics and formatting for Luau, powered by [larvae](https://github.com/larvae-luau/larvae).

The extension launches `larvae lsp` and talks to it over stdio:

- **Diagnostics** — larvae's lints show up in the editor and the Problems panel as you type, with their native severities (errors as errors, warnings as warnings).
- **Formatting** — larvae registers as a document formatter, so *Format Document* and format-on-save run `larvae fmt`'s formatter on the current file.
- **Code actions** — fixes the server offers for its findings appear as quick fixes, next to the extension's own allow-flag suppressions.
- **Worm types** — type definitions supplied by the project's worms are written to `.larvae/definitions/` and listed in luau-lsp's `types.definitionFiles` setting, so its typing picks them up. The two extensions stay independent; without luau-lsp the setting is inert.

## Requirements

The `larvae` binary must be installed (`larvae self install` puts it in `~/.larvae/bin`, which the extension finds automatically). If it lives somewhere else, point `larvae.path` at it.

Hover, completions, and type diagnostics come from the `larvae-lsp` binary, which carries the Luau analyzer. When it sits beside the `larvae` binary (or on `PATH`), the extension launches it instead of `larvae lsp`; without it, lint diagnostics and formatting still work through `larvae lsp` alone.

## Format on save

Set larvae as the default formatter for Luau and enable format-on-save in your `settings.json`:

```json
{
    "[luau]": {
        "editor.defaultFormatter": "AndrewBordis.larvae",
        "editor.formatOnSave": true
    }
}
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `larvae.path` | `""` | Path to the `larvae` executable. Empty means `larvae` on `PATH`, falling back to `~/.larvae/bin/larvae`. |
| `larvae.processOnSave` | `false` | Run `larvae process` for the containing workspace folder whenever a Luau file is saved. Output lands in the *Larvae Process* output channel. |
| `larvae.processProfile` | `""` | Profile passed as `larvae process --profile <name>`, merging `[profile.<name>]` from `larvae.toml` over the base config. Empty builds with the base config. |
| `larvae.hideOutputFolder` | `true` | Hide larvae's output directory (`output` in `larvae.toml`) from the explorer via a `files.exclude` entry. The entry is written once per folder; deleting it by hand sticks, and toggling the setting off and on writes it again. Only touches folders containing a `larvae.toml`. |
| `larvae-lsp.enabled` | `true` | Start the language server at all. Project side: `[lsp] enabled`. |
| `larvae-lsp.claimOnly` | `true` | Serve only worm-claimed files (e.g. `.luaux`), leaving plain Luau to luau-lsp. Project side: `[lsp] claim_only`. |
| `larvae-lsp.completion.imports.useConst` | `true` | Auto-imports bind with `const` instead of `local`. Project side: `[lsp.completion.imports] use_const`. |
| `larvae.trace.server` | `off` | Log LSP traffic to the Larvae output channel (`messages` or `verbose`). |

The `larvae-lsp.*` ids mirror the `[lsp]` table in `larvae.toml`: the editor setting is the personal side, the project file is the shared side, and where both speak, the project wins.

## Working alongside luau-lsp

larvae can replace luau-lsp or run beside it; the difference is which files the server attaches to:

- **Side by side (default)** — larvae only serves worm-claimed files (e.g. `.luaux`), and luau-lsp keeps normal Luau to itself.
- **Drop-in** — turn `larvae-lsp.claimOnly` off and larvae serves plain Luau and Lua files as well. A project can fix either mode for every contributor with `claim_only` under `[lsp]` in `larvae.toml`; the project file wins over the editor setting.

## Commands

- **Larvae: Restart Language Server** — restarts `larvae lsp` (also happens automatically when `larvae.path` changes).

## Development

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.
