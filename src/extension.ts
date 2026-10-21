import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

function versionOf(command: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, ['--version'], { timeout: 5000 }, (error, stdout) => {
			// output looks like "larvae 0.1.1"
			resolve(error ? undefined : stdout.trim().split(/\s+/).pop())
		})
	})
}

function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(Number),
		right = b.split('.').map(Number)

	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const delta = (left[i] ?? 0) - (right[i] ?? 0)
		if (delta !== 0) return delta
	}

	return 0
}

function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue

		const candidate = path.join(dir, name)
		try {
			fs.accessSync(candidate, fs.constants.X_OK)
			return candidate
		} catch {
			// not here; keep looking
		}
	}

	return undefined
}

// version of the binary the server was last resolved to, for the restart toast
let serverVersion: string | undefined

// Resolved fresh on every (re)start so updates are picked up: an explicit
// larvae.path always wins; otherwise the newest of `larvae self install`'s
// binary and whatever `larvae` is on PATH.
async function findServerCommand(): Promise<string> {
	serverVersion = undefined

	const configured = vscode.workspace
		.getConfiguration('larvae')
		.get<string>('path')

	if (configured && configured.trim().length > 0) {
		const command = configured.trim()
		serverVersion = await versionOf(command)
		return command
	}

	const candidates: string[] = []

	// `larvae self install` puts the binary here; it may not be on VS Code's
	// PATH (e.g. when launched from a desktop shell)
	const installed = path.join(os.homedir(), '.larvae', 'bin', 'larvae')
	if (fs.existsSync(installed)) candidates.push(installed)

	const onPath = findOnPath(
		process.platform === 'win32' ? 'larvae.exe' : 'larvae',
	)
	if (onPath && !candidates.includes(onPath)) candidates.push(onPath)

	if (candidates.length === 0) return 'larvae'

	let best = candidates[0],
		bestVersion = await versionOf(best)

	for (const candidate of candidates.slice(1)) {
		const version = await versionOf(candidate)
		if (
			version &&
			(!bestVersion || compareVersions(version, bestVersion) > 0)
		) {
			best = candidate
			bestVersion = version
		}
	}

	serverVersion = bestVersion
	return best
}

const LINT_DOCS_URL = 'https://larvae-luau.github.io/docs/reference/linting'

function rawLintCode(code: vscode.Diagnostic['code']): string | undefined {
	const raw = typeof code === 'object' ? code.value : code
	return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

// unused_variable -> UnusedVariable
function pascalCaseLintCode(code: string): string {
	return code
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join('')
}

/*
Reads one boolean from the [lsp] section of a folder's larvae.toml.
Undefined when the project does not speak about that key.

The server applies the same rule over the whole table, and it cannot
apply it to `enabled`: a server the client never starts reads no
config at all. So the two keys the client itself acts on are read
here, by the same rule, and the project wins at the gate as well.
*/
function readLspBool(
	folder: vscode.WorkspaceFolder,
	key: string,
): boolean | undefined {
	let toml: string
	try {
		toml = fs.readFileSync(path.join(folder.uri.fsPath, 'larvae.toml'), 'utf8')
	} catch {
		return undefined
	}

	const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\b`)
	let inLsp = false

	for (const line of toml.split('\n')) {
		const header = line.match(/^\s*\[(.+?)\]/)
		if (header) {
			inLsp = header[1].trim() === 'lsp'
			continue
		}
		if (!inLsp) continue

		const value = line.match(pattern)
		if (value) return value[1] === 'true'
	}

	return undefined
}

function readClaimOnly(folder: vscode.WorkspaceFolder): boolean | undefined {
	return readLspBool(folder, 'claim_only')
}

/*
Whether any workspace folder's larvae.toml turns the server on or off.

The first folder that speaks decides, which is the rule the rest of
the settings follow.
*/
function projectEnabled(): boolean | undefined {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const value = readLspBool(folder, 'enabled')

		if (value !== undefined) return value
	}

	return undefined
}

// Whether the server gets plain Luau files, or only worm-claimed ones. The
// project speaks through [lsp] claim_only and wins over the claimOnly editor
// setting, so a checkout behaves the same for the whole team. In claim-only
// mode larvae lints and formats only the files of worms.
function includePlainLuau(): boolean {
	let projectSaysServeAll = false
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const spoken = readClaimOnly(folder)
		if (spoken === true) return false
		if (spoken === false) projectSaysServeAll = true
	}
	if (projectSaysServeAll) return true

	// the server's own default is claim_only = false, and the extension
	// always sends its declared value, so the two agree
	const claimOnly =
		vscode.workspace.getConfiguration('larvae-lsp').get<boolean>('claimOnly') ??
		false
	return !claimOnly
}

/*
The `larvae-lsp` settings, whole, for the initialize handshake.

The server reads `enabled` and `claimOnly` from them. A change to either
restarts the client, so the next initialize carries the new values.
*/
function editorSettings(): Record<string, unknown> {
	return (
		vscode.workspace
			.getConfiguration()
			.get<Record<string, unknown>>('larvae-lsp') ?? {}
	)
}

type Claims = { claims?: string[] }

// The extensions the project's worms claim, without the dot. Refreshed
// whenever the client starts, which is also whenever larvae.toml changes.
let claimed: string[] = []

/*
The file extensions the project's worms claim, e.g. [".luaux"].

larvae answers from the manifests it installed, so no worm is named here and
a worm that claims a new extension needs no release of this extension.

`undefined` is a larvae that could not answer: too old for the subcommand,
or not runnable. That is not the same as a project with no worms, and the
caller keeps the client running rather than concluding there is nothing to
serve.
*/
function readClaims(
	folder: vscode.WorkspaceFolder,
): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		void findServerCommand().then((command) => {
			execFile(
				command,
				['worm', 'claims'],
				{ cwd: folder.uri.fsPath, timeout: 10000 },
				(error, stdout) => {
					if (error) return resolve(undefined)

					try {
						const reply = JSON.parse(stdout) as Claims
						resolve(reply.claims ?? [])
					} catch {
						resolve(undefined)
					}
				},
			)
		})
	})
}

// The files larvae serves, as a language client selector.
//
// A claimed file is matched by its path and not by its language id, because
// the id belongs to whichever extension registered the language and larvae
// registers none: a worm's language is the worm's to ship. Plain Luau is
// matched by id, since larvae contributes that one itself.
async function documentSelectorFor(): Promise<
	{ scheme: string; language?: string; pattern?: string }[]
> {
	const found = new Set<string>()
	let answered = true

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const extensions = await readClaims(folder)

		if (extensions === undefined) {
			answered = false
			continue
		}

		for (const extension of extensions) {
			// `.luaux` and `luaux` both reach here from a manifest
			found.add(extension.replace(/^\./, ''))
		}
	}

	claimed = [...found]

	const selector = claimed.map((extension) => ({
		scheme: 'file',
		pattern: `**/*.${extension}`,
	}))

	if (includePlainLuau()) {
		selector.push(
			{ scheme: 'file', language: 'luau' } as never,
			{ scheme: 'file', language: 'lua' } as never,
		)
	}

	// larvae could not say what it claims, so serve Luau and let the server
	// decline what is not its own. Silence is not an empty project.
	if (selector.length === 0 && !answered) {
		return [
			{ scheme: 'file', language: 'luau' },
			{ scheme: 'file', language: 'lua' },
		]
	}

	return selector
}

async function startClient(): Promise<void> {
	/*
	The project wins here too. A server the client never starts reads
	no larvae.toml, so the editor setting alone would keep a project
	that says `enabled = true` from ever being served.
	*/
	const lspSettings = vscode.workspace.getConfiguration('larvae-lsp')
	const enabled =
		projectEnabled() ?? lspSettings.get<boolean>('enabled') ?? true

	if (!enabled) return

	const command = await findServerCommand()
	const args = ['lsp']

	const serverOptions: ServerOptions = {
		command,
		args,
	}

	const documentSelector = await documentSelectorFor()

	// Nothing to serve: no worm claims a file, and claim-only mode leaves plain
	// Luau to other tools. A server that every request declines helps nobody.
	if (documentSelector.length === 0) return

	const clientOptions: LanguageClientOptions = {
		documentSelector,
		// one channel for every client this session starts, or each
		// restart would leave another dead panel behind
		outputChannel: output(),
		// editor-side settings travel at initialize; the server treats
		// larvae.toml as the project side and wins where both speak
		initializationOptions: {
			settings: {
				'larvae-lsp': editorSettings(),
			},
		},
		middleware: {
			handleDiagnostics(uri, diagnostics, next) {
				for (const diagnostic of diagnostics) {
					if (diagnostic.source !== 'larvae') continue

					const code = rawLintCode(diagnostic.code)
					if (!code) continue

					diagnostic.message = `${pascalCaseLintCode(code)}: ${diagnostic.message}`
					// render the code in parens as a link to the rule's doc section
					diagnostic.code = {
						value: code,
						target: vscode.Uri.parse(
							`${LINT_DOCS_URL}#${code.replaceAll('_', '-')}`,
						),
					}
				}
				next(uri, diagnostics)
			},
		},
	}

	client = new LanguageClient('larvae', 'Larvae', serverOptions, clientOptions)

	log(`starting ${[command, ...args].join(' ')}`)
	log(`serving ${documentSelector.length} selector(s)`)

	try {
		await client.start()
		log(`started${serverVersion ? ` (larvae ${serverVersion})` : ''}`)
		log(`claims: ${claimed.length ? claimed.join(', ') : 'none'}`)
	} catch {
		client = undefined

		const choice = await vscode.window.showErrorMessage(
			`Failed to start the larvae language server ("${[command, ...args].join(' ')}"). ` +
				'Is larvae installed and on your PATH?',
			'Open Settings',
		)

		if (choice === 'Open Settings') {
			await vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'larvae.path',
			)
		}
	}
}

const ALLOW_FLAG = /--\s*(?:larvae|selene):\s*allow\(([^)]*)\)/

// Appends `-- larvae: allow(<rule>)` to the line, or merges the rule into an
// allow flag already present on it.
function buildAllowEdit(
	document: vscode.TextDocument,
	line: number,
	rule: string,
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit(),
		lineText = document.lineAt(line),
		existing = ALLOW_FLAG.exec(lineText.text)

	if (existing) {
		const rules = existing[1]
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)

		let merged: string[]
		if (rule === '*') {
			merged = ['*']
		} else if (rules.includes(rule) || rules.includes('*')) {
			merged = rules
		} else {
			merged = [...rules, rule]
		}

		const open = existing.index + existing[0].indexOf('('),
			close = existing.index + existing[0].lastIndexOf(')')

		edit.replace(
			document.uri,
			new vscode.Range(line, open + 1, line, close),
			merged.join(', '),
		)
	} else {
		const spacer = /(^$|\s$)/.test(lineText.text) ? '' : ' '
		edit.insert(
			document.uri,
			lineText.range.end,
			`${spacer}-- larvae: allow(${rule})`,
		)
	}

	return edit
}

const ignoreQuickFixProvider: vscode.CodeActionProvider = {
	provideCodeActions(document, _range, context) {
		const actions: vscode.CodeAction[] = [],
			seenRules = new Set<string>(),
			seenStarLines = new Set<number>()

		for (const diagnostic of context.diagnostics) {
			if (diagnostic.source !== 'larvae') continue

			const code = rawLintCode(diagnostic.code)
			if (!code) continue

			const line = diagnostic.range.start.line

			if (!seenRules.has(`${line}:${code}`)) {
				seenRules.add(`${line}:${code}`)

				const action = new vscode.CodeAction(
					`Ignore ${code} on this line`,
					vscode.CodeActionKind.QuickFix,
				)
				action.diagnostics = [diagnostic]
				action.edit = buildAllowEdit(document, line, code)
				action.isPreferred = true
				actions.push(action)
			}

			if (!seenStarLines.has(line)) {
				seenStarLines.add(line)

				const action = new vscode.CodeAction(
					'Ignore all larvae lints on this line',
					vscode.CodeActionKind.QuickFix,
				)
				action.diagnostics = [diagnostic]
				action.edit = buildAllowEdit(document, line, '*')
				actions.push(action)
			}
		}

		return actions
	},
}

let processOutput: vscode.OutputChannel | undefined

/*
The server's output channel, created once and reused by every client.

`new LanguageClient` makes a channel of its own for each instance, and
larvae restarts the client whenever `larvae.toml` changes, so each edit
left another dead "Larvae" panel in the output list. One channel owned
here outlives the clients that write to it.
*/
let serverOutput: vscode.OutputChannel | undefined

/// The channel, made on the first call and kept for the session
function output(): vscode.OutputChannel {
	if (!serverOutput) {
		serverOutput = vscode.window.createOutputChannel('Larvae')
		extensionContext?.subscriptions.push(serverOutput)
	}

	return serverOutput
}

/*
A line in the server channel, when `larvae-lsp.verbose` asks for it.

The setting is for the reports that start "it does nothing": the launch
line, the settings the client sent, what the project claimed, and every
restart with its reason. `larvae.trace.server` covers the protocol
traffic itself, which is a different volume of noise.
*/
function log(message: string): void {
	if (
		!vscode.workspace.getConfiguration('larvae-lsp').get<boolean>('verbose')
	) {
		return
	}

	const now = new Date().toISOString().slice(11, 23)

	output().appendLine(`[${now}] ${message}`)
}

// One entry per workspace folder with a `larvae process` run in flight.
// Saves that land mid-run set `queued` so the folder is rebuilt once more.
const processRuns = new Map<string, { queued: boolean }>()

async function runProcess(
	folder: vscode.WorkspaceFolder,
	profile: string,
): Promise<void> {
	const command = await findServerCommand()

	return new Promise((resolve) => {
		const args = ['process']
		if (profile) args.push('--profile', profile)

		const output = processOutput
		output?.appendLine(`[${folder.name}] ${command} ${args.join(' ')}`)

		execFile(
			command,
			args,
			{ cwd: folder.uri.fsPath },
			(error, stdout, stderr) => {
				if (stdout) output?.append(stdout)
				if (stderr) output?.append(stderr)

				if (error) {
					output?.appendLine(`[${folder.name}] failed: ${error.message}`)

					void vscode.window
						.showErrorMessage('larvae process failed.', 'Show Output')
						.then((choice) => {
							if (choice === 'Show Output') {
								output?.show(true)
							}
						})
				}

				resolve()
			},
		)
	})
}

// Whether this file is one larvae answers for: plain Luau, or a file some
// worm of the project claims.
function isServed(document: vscode.TextDocument): boolean {
	if (['luau', 'lua'].includes(document.languageId)) return true

	return claimed.some((extension) =>
		document.uri.fsPath.endsWith(`.${extension}`),
	)
}

async function processOnSave(document: vscode.TextDocument): Promise<void> {
	if (document.uri.scheme !== 'file') return
	if (!isServed(document)) return

	const config = vscode.workspace.getConfiguration('larvae', document.uri)
	if (!config.get<boolean>('processOnSave')) return

	const folder = vscode.workspace.getWorkspaceFolder(document.uri)
	if (!folder) return

	const key = folder.uri.toString(),
		inFlight = processRuns.get(key)
	if (inFlight) {
		inFlight.queued = true
		return
	}

	const run = { queued: false }
	processRuns.set(key, run)

	try {
		do {
			run.queued = false

			await runProcess(
				folder,
				config.get<string>('processProfile')?.trim() ?? '',
			)
		} while (run.queued)
	} finally {
		processRuns.delete(key)
	}
}

// Reads `output = "..."` from larvae.toml; undefined when there is no
// larvae.toml (i.e. the folder is not a larvae project).
function readOutputDir(folder: vscode.WorkspaceFolder): string | undefined {
	let toml: string
	try {
		toml = fs.readFileSync(path.join(folder.uri.fsPath, 'larvae.toml'), 'utf8')
	} catch {
		return undefined
	}

	// only look above the first [section] so profile overrides don't match
	const topLevel = toml.split(/^\s*\[/m, 1)[0]
	const match = topLevel.match(/^\s*output\s*=\s*"([^"]+)"/m)

	return match ? match[1] : 'dist'
}

// set in activate; carries the memory of which exclusions we already wrote
let extensionContext: vscode.ExtensionContext | undefined

// Hides/unhides the larvae output directory by managing one entry in the
// workspace's files.exclude, based on the hideOutputFolder setting.
//
// The exclusion is written once per folder and remembered in workspaceState.
// A user who deletes the entry by hand keeps it deleted across reloads; only
// turning the setting off and on again re-adds it.
async function updateOutputFolderVisibility(): Promise<void> {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const outputDir = readOutputDir(folder)
		if (!outputDir) continue

		const hide =
			vscode.workspace
				.getConfiguration('larvae', folder.uri)
				.get<boolean>('hideOutputFolder') ?? true

		const key = outputDir.replace(/^\.?\//, '').replace(/\/+$/, '')
		if (!key) continue

		const memory = extensionContext?.workspaceState,
			memoryKey = `hidOutput:${folder.uri.toString()}:${key}`,
			alreadyWritten = memory?.get<boolean>(memoryKey) ?? false

		const files = vscode.workspace.getConfiguration('files', folder.uri),
			inspected = files.inspect<Record<string, boolean>>('exclude'),
			current =
				inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? {}

		if (hide) {
			// written before: leave the user's current state alone, whether
			// they kept the entry or removed it by hand
			if (alreadyWritten || current[key] === true) {
				await memory?.update(memoryKey, true)
				continue
			}

			try {
				await files.update(
					'exclude',
					{ ...current, [key]: true },
					vscode.ConfigurationTarget.WorkspaceFolder,
				)
				await memory?.update(memoryKey, true)
			} catch {
				// workspace settings are not writable here; skip quietly
			}
		} else {
			if (key in current) {
				const next = { ...current }
				delete next[key]

				try {
					await files.update(
						'exclude',
						next,
						vscode.ConfigurationTarget.WorkspaceFolder,
					)
				} catch {
					// workspace settings are not writable here; skip quietly
				}
			}

			// forget the write, so turning the setting back on adds it again
			if (alreadyWritten) await memory?.update(memoryKey, undefined)
		}
	}
}

// The server reads larvae.toml once at startup, so config edits need a
// restart to apply. Debounced so a burst of file events restarts it once.
let restartTimer: NodeJS.Timeout | undefined

function scheduleServerRestart(): void {
	if (restartTimer) clearTimeout(restartTimer)

	restartTimer = setTimeout(async () => {
		restartTimer = undefined
		log('larvae.toml changed, restarting')
		await stopClient()
		await startClient()
	}, 300)
}

async function stopClient(): Promise<void> {
	if (!client) return

	const stopping = client
	client = undefined

	log('stopping the server')
	await stopping.stop()
}

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	extensionContext = context

	context.subscriptions.push(
		vscode.commands.registerCommand('larvae.restartServer', async () => {
			await stopClient()
			await startClient()

			if (client) {
				const version = serverVersion ? ` (larvae ${serverVersion})` : ''
				vscode.window.showInformationMessage(
					`Larvae language server restarted${version}`,
				)
			}
		}),
	)

	/*
	The quick fix runs on every file and answers only where a larvae
	diagnostic sits, which is the check the provider already makes. A
	narrower selector would have to name a worm's language, and larvae
	does not know one.
	*/
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file' },
			ignoreQuickFixProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
	)

	processOutput = vscode.window.createOutputChannel('Larvae Process')
	context.subscriptions.push(processOutput)

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {
			void processOnSave(document)
		}),
	)

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (
				event.affectsConfiguration('larvae.path') ||
				event.affectsConfiguration('larvae-lsp.enabled') ||
				event.affectsConfiguration('larvae-lsp.claimOnly')
			) {
				await stopClient()
				await startClient()
			}

			if (event.affectsConfiguration('larvae.hideOutputFolder')) {
				await updateOutputFolderVisibility()
			}
		}),
	)

	// when larvae.toml appears, changes, or goes away: re-check the hidden
	// output folder and restart the server so the new config applies
	const tomlWatcher = vscode.workspace.createFileSystemWatcher('**/larvae.toml')
	context.subscriptions.push(tomlWatcher)

	const onTomlEvent = () => {
		void updateOutputFolderVisibility()
		scheduleServerRestart()
	}
	tomlWatcher.onDidCreate(onTomlEvent, null, context.subscriptions)
	tomlWatcher.onDidChange(onTomlEvent, null, context.subscriptions)
	tomlWatcher.onDidDelete(onTomlEvent, null, context.subscriptions)

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(
			() => void updateOutputFolderVisibility(),
		),
	)

	void updateOutputFolderVisibility()

	await startClient()
}

export function deactivate(): Promise<void> | undefined {
	return stopClient()
}
