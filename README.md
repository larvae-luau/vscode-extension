# Larvae for VS Code

Lints, formatting, and lint fixes for Luau, from [larvae](https://github.com/larvae-luau/larvae).

The extension launches `larvae lsp` and talks to it over stdio. Types come from [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp), which runs beside it:

- **Diagnostics**: larvae's lints show up in the editor and the Problems panel as you type, with their native severities (errors as errors, warnings as warnings).
- **Formatting**: larvae registers as a document formatter, so *Format Document* and format-on-save run `larvae fmt`'s formatter on the current file.
- **Highlighting**: the bundled grammar is luau-lsp's (so plain Luau colors identically), extended with the `class`, `extern`, `extends`, and `public` syntax; `const` and `export` come with it upstream.
- **Code actions**: fixes the server offers for its findings appear as quick fixes, next to the extension's own allow-flag suppressions.
- **Worm files**: a file a worm of the project claims (e.g. `.luaux`) gets the diagnostics and the layout of that worm.

## Requirements

The `larvae` binary must be installed (`larvae self install` puts it in `~/.larvae/bin`, which the extension finds automatically). If it lives somewhere else, point `larvae.path` at it.

Install the [luau-lsp extension](https://marketplace.visualstudio.com/items?itemName=JohnnyMorganz.luau-lsp) beside this one. It serves hover, completion, type diagnostics, and navigation. larvae serves none of these, so the two servers never answer the same request.

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

## Completions inside strings

A require path is typed inside a string, and VS Code hides quick suggestions there. The extension ships a `[luau]` default that turns them on, so luau-lsp can offer the paths of the project after `require("`:

```json
{
    "[luau]": {
        "editor.quickSuggestions": { "strings": true }
    }
}
```

Write the same key in your own settings to turn it off again.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `larvae.path` | `""` | Path to the `larvae` executable. Empty means `larvae` on `PATH`, falling back to `~/.larvae/bin/larvae`. |
| `larvae.processOnSave` | `false` | Run `larvae process` for the containing workspace folder whenever a Luau file is saved. Output lands in the *Larvae Process* output channel. |
| `larvae.processProfile` | `""` | Profile passed as `larvae process --profile <name>`, merging `[profile.<name>]` from `larvae.toml` over the base config. Empty builds with the base config. |
| `larvae.hideOutputFolder` | `true` | Hide larvae's output directory (`output` in `larvae.toml`) from the explorer via a `files.exclude` entry. The entry is written once per folder; deleting it by hand sticks, and toggling the setting off and on writes it again. Only touches folders containing a `larvae.toml`. |
| `larvae-lsp.enabled` | `true` | Start the language server at all. Project side: `[lsp] enabled`. |
| `larvae-lsp.claimOnly` | `false` | Lint and format only worm-claimed files (e.g. `.luaux`), and leave plain Luau to other tools. Project side: `[lsp] claim_only`. |
| `larvae-lsp.verbose` | `false` | Write the launch, the claims, and every restart to the *Larvae* output channel. |
| `larvae.trace.server` | `off` | Log LSP traffic to the Larvae output channel (`messages` or `verbose`). |

The `larvae-lsp.*` ids mirror the `[lsp]` table in `larvae.toml`: the editor setting is the personal side, the project file is the shared side, and where both speak, the project wins.

## Working alongside luau-lsp

luau-lsp serves the types, and larvae serves the lints, the format, and the fixes. Set larvae as the default formatter for Luau (see above), so that one formatter owns the file.

- **Default**: larvae lints and formats plain Luau and Lua files, and the files that worms claim.
- **Claim-only**: turn `larvae-lsp.claimOnly` on and larvae serves only the worm-claimed files (e.g. `.luaux`). Use it when another linter and formatter own plain Luau. A project can fix either mode for every contributor with `claim_only` under `[lsp]` in `larvae.toml`; the project file wins over the editor setting.

## Commands

- **Larvae: Restart Language Server**: restarts `larvae lsp` (also happens automatically when `larvae.path` changes).

## Development

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.
