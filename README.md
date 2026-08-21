# Larvae for VS Code

Lint diagnostics and formatting for Luau, powered by [larvae](https://github.com/larvae-luau/larvae).

The extension launches `larvae lsp` and talks to it over stdio:

- **Diagnostics** — larvae's lints show up in the editor and the Problems panel as you type, with their native severities (errors as errors, warnings as warnings).
- **Formatting** — larvae registers as a document formatter, so *Format Document* and format-on-save run `larvae fmt`'s formatter on the current file.
- **Code actions** — fixes the server offers for its findings appear as quick fixes, next to the extension's own allow-flag suppressions.
- **Worm types** — type definitions supplied by the project's worms are written to `.larvae/definitions/` and listed in luau-lsp's `types.definitionFiles` setting, so its typing picks them up. The two extensions stay independent; without luau-lsp the setting is inert.

## Requirements

The `larvae` binary must be installed (`larvae self install` puts it in `~/.larvae/bin`, which the extension finds automatically). If it lives somewhere else, point `larvae.path` at it.

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
| `larvae.trace.server` | `off` | Log LSP traffic to the Larvae output channel (`messages` or `verbose`). |

## Commands

- **Larvae: Restart Language Server** — restarts `larvae lsp` (also happens automatically when `larvae.path` changes).

## Development

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.
