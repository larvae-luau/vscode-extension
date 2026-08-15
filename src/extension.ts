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

let processOutput: vscode.OutputChannel | undefined

// One entry per workspace folder with a `larvae process` run in flight.
// Saves that land mid-run set `queued` so the folder is rebuilt once more.
const processRuns = new Map<string, { queued: boolean }>()

function runProcess(
	folder: vscode.WorkspaceFolder,
	profile: string,
): Promise<void> {
	return new Promise((resolve) => {
		const command = findServerCommand()
		const args = ['process']
		if (profile) {
			args.push('--profile', profile)
		}
		const output = processOutput
		output?.appendLine(`[${folder.name}] ${command} ${args.join(' ')}`)
		execFile(
			command,
			args,
			{ cwd: folder.uri.fsPath },
			(error, stdout, stderr) => {
				if (stdout) {
					output?.append(stdout)
				}
				if (stderr) {
					output?.append(stderr)
				}
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
	if (document.uri.scheme !== 'file') {
		return
	}
	if (!['luau', 'luaux', 'lua'].includes(document.languageId)) {
		return
	}
	const config = vscode.workspace.getConfiguration('larvae', document.uri)
	if (!config.get<boolean>('processOnSave')) {
		return
	}
	const folder = vscode.workspace.getWorkspaceFolder(document.uri)
	if (!folder) {
		return
	}

	const key = folder.uri.toString()
	const inFlight = processRuns.get(key)
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

async function stopClient(): Promise<void> {
	if (client) {
		const stopping = client
		client = undefined
		await stopping.stop()
	}
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
		}),
	)

	await startClient()
}

export function deactivate(): Promise<void> | undefined {
	return stopClient()
}
