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

// Reads `worm_files_only` from the [lint] section of a folder's larvae.toml.
function readWormFilesOnly(folder: vscode.WorkspaceFolder): boolean {
	let toml: string
	try {
		toml = fs.readFileSync(path.join(folder.uri.fsPath, 'larvae.toml'), 'utf8')
	} catch {
		return false
	}

	let inLint = false
	for (const line of toml.split('\n')) {
		const header = line.match(/^\s*\[(.+?)\]/)
		if (header) {
			inLint = header[1].trim() === 'lint'
			continue
		}
		if (inLint && /^\s*worm_files_only\s*=\s*true\b/.test(line)) {
			return true
		}
	}

	return false
}

// Whether the server gets plain Luau files, or only worm-claimed ones.
// Both the luauFiles setting and larvae.toml can turn plain Luau off; the
// project file wins so a checkout behaves the same for the whole team. With
// plain Luau off, larvae runs beside luau-lsp instead of replacing it.
function includePlainLuau(): boolean {
	const setting =
		vscode.workspace.getConfiguration('larvae').get<boolean>('luauFiles') ??
		false
	if (!setting) return false

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (readWormFilesOnly(folder)) return false
	}

	return true
}

async function startClient(): Promise<void> {
	const command = await findServerCommand()

	const serverOptions: ServerOptions = {
		command,
		args: ['lsp'],
	}

	const documentSelector = [{ scheme: 'file', language: 'luaux' }]
	if (includePlainLuau()) {
		documentSelector.push(
			{ scheme: 'file', language: 'luau' },
			{ scheme: 'file', language: 'lua' },
		)
	}

	const clientOptions: LanguageClientOptions = {
		documentSelector,
		// the full larvae section travels at initialize, changes are pushed as
		// didChangeConfiguration, and workspace/configuration pulls also answer
		initializationOptions: {
			settings: JSON.parse(
				JSON.stringify(vscode.workspace.getConfiguration('larvae')),
			),
		},
		synchronize: {
			configurationSection: 'larvae',
		},
		middleware: {
			handleDiagnostics(uri, diagnostics, next) {
				for (const diagnostic of diagnostics) {
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

	try {
		await client.start()
		void syncWormDefinitions()
	} catch {
		client = undefined

		const choice = await vscode.window.showErrorMessage(
			`Failed to start the larvae language server ("${command} lsp"). ` +
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

type WormDefinition = { worm: string; text: string }

// where worm-supplied definition files land, relative to the project root;
// larvae's init already gitignores .larvae/
const DEFINITIONS_DIR = path.join('.larvae', 'definitions')

function definitionFileName(worm: string): string {
	return `${worm.replace(/[^\w.-]/g, '-')}.d.luau`
}

// Fetches the type definitions the project's worms supply and hands them to
// luau-lsp: written as .d.luau files and listed in its definitionFiles
// setting, so the types apply without either extension knowing the other.
async function syncWormDefinitions(): Promise<void> {
	if (!client) return

	let definitions: WormDefinition[]
	try {
		const reply = await client.sendRequest<{ definitions?: WormDefinition[] }>(
			'larvae/definitions',
		)
		definitions = reply?.definitions ?? []
	} catch {
		// an older server has no larvae/definitions; nothing to sync
		return
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (!fs.existsSync(path.join(folder.uri.fsPath, 'larvae.toml'))) continue

		const dir = path.join(folder.uri.fsPath, DEFINITIONS_DIR),
			wanted = new Map(
				definitions.map((d) => [definitionFileName(d.worm), d.text]),
			)

		try {
			if (wanted.size > 0) fs.mkdirSync(dir, { recursive: true })

			for (const [name, text] of wanted) {
				const file = path.join(dir, name)
				let current: string | undefined
				try {
					current = fs.readFileSync(file, 'utf8')
				} catch {
					// not written yet
				}
				if (current !== text) fs.writeFileSync(file, text)
			}

			// drop files for worms that no longer supply definitions
			if (fs.existsSync(dir)) {
				for (const name of fs.readdirSync(dir)) {
					if (!wanted.has(name)) fs.unlinkSync(path.join(dir, name))
				}
			}
		} catch {
			// the project dir is not writable; leave luau-lsp untouched
			continue
		}

		// maintain our entries in luau-lsp's definition file list, keeping any
		// the user added themselves
		const ours = [...wanted.keys()].map((name) =>
			[DEFINITIONS_DIR, name].join(path.sep),
		)

		const config = vscode.workspace.getConfiguration('luau-lsp', folder.uri),
			inspected = config.inspect<string[]>('types.definitionFiles'),
			current =
				inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? [],
			kept = current.filter((entry) => !entry.startsWith(DEFINITIONS_DIR)),
			next = [...kept, ...ours]

		if (
			next.length === current.length &&
			next.every((entry, i) => entry === current[i])
		) {
			continue
		}

		try {
			await config.update(
				'types.definitionFiles',
				next.length > 0 ? next : undefined,
				vscode.ConfigurationTarget.WorkspaceFolder,
			)
		} catch {
			// workspace settings are not writable here; skip quietly
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

async function processOnSave(document: vscode.TextDocument): Promise<void> {
	if (document.uri.scheme !== 'file') return
	if (!['luau', 'luaux', 'lua'].includes(document.languageId)) return

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
		await stopClient()
		await startClient()
	}, 300)
}

async function stopClient(): Promise<void> {
	if (!client) return

	const stopping = client
	client = undefined

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

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			['luau', 'luaux', 'lua'].map((language) => ({
				scheme: 'file' as const,
				language,
			})),
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
				event.affectsConfiguration('larvae.luauFiles')
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
