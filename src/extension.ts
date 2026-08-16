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

function findServerCommand(): string {
	const configured = vscode.workspace
		.getConfiguration('larvae')
		.get<string>('path')

	if (configured && configured.trim().length > 0) {
		return configured.trim()
	}
	// `larvae self install` puts the binary here; it may not be on VS Code's
	// PATH (e.g. when launched from a desktop shell), so fall back to it.
	const installed = path.join(os.homedir(), '.larvae', 'bin', 'larvae')

	if (fs.existsSync(installed)) {
		return installed
	}

	return 'larvae'
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

async function startClient(): Promise<void> {
	const command = findServerCommand()

	const serverOptions: ServerOptions = {
		command,
		args: ['lsp'],
	}

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'luau' },
			{ scheme: 'file', language: 'luaux' },
			{ scheme: 'file', language: 'lua' },
		],
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

function runProcess(
	folder: vscode.WorkspaceFolder,
	profile: string,
): Promise<void> {
	return new Promise((resolve) => {
		const command = findServerCommand(),
			args = ['process']
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

// Hides/unhides the larvae output directory by managing one entry in the
// workspace's files.exclude, based on the hideOutputFolder setting.
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

		const files = vscode.workspace.getConfiguration('files', folder.uri),
			inspected = files.inspect<Record<string, boolean>>('exclude'),
			current =
				inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? {}

		const upToDate = hide ? current[key] === true : !(key in current)
		if (upToDate) continue

		const next = { ...current }
		if (hide) next[key] = true
		else delete next[key]

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
	context.subscriptions.push(
		vscode.commands.registerCommand('larvae.restartServer', async () => {
			await stopClient()
			await startClient()
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
			if (event.affectsConfiguration('larvae.path')) {
				await stopClient()
				await startClient()
			}

			if (event.affectsConfiguration('larvae.hideOutputFolder')) {
				await updateOutputFolderVisibility()
			}
		}),
	)

	// re-check when larvae.toml appears, changes, or goes away, since the
	// output directory (and larvae-project-ness) comes from it
	const tomlWatcher = vscode.workspace.createFileSystemWatcher('**/larvae.toml')
	context.subscriptions.push(tomlWatcher)
	tomlWatcher.onDidCreate(
		() => void updateOutputFolderVisibility(),
		null,
		context.subscriptions,
	)
	tomlWatcher.onDidChange(
		() => void updateOutputFolderVisibility(),
		null,
		context.subscriptions,
	)
	tomlWatcher.onDidDelete(
		() => void updateOutputFolderVisibility(),
		null,
		context.subscriptions,
	)

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
