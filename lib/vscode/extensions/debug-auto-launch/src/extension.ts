/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { createServer, Server } from 'net';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();
const TEXT_ALWAYS = localize('status.text.auto.attach.always', 'Auto Attach: Always');
const TEXT_SMART = localize('status.text.auto.attach.smart', 'Auto Attach: Smart');
const TEXT_WITH_FLAG = localize('status.text.auto.attach.withFlag', 'Auto Attach: With Flag');
const TEXT_STATE_LABEL = {
	[State.Disabled]: localize('debug.javascript.autoAttach.disabled.label', 'Disabled'),
	[State.Always]: localize('debug.javascript.autoAttach.always.label', 'Always'),
	[State.Smart]: localize('debug.javascript.autoAttach.smart.label', 'Smart'),
	[State.OnlyWithFlag]: localize(
		'debug.javascript.autoAttach.onlyWithFlag.label',
		'Only With Flag',
	),
};
const TEXT_STATE_DESCRIPTION = {
	[State.Disabled]: localize(
		'debug.javascript.autoAttach.disabled.description',
		'Auto attach is disabled and not shown in status bar',
	),
	[State.Always]: localize(
		'debug.javascript.autoAttach.always.description',
		'Auto attach to every Node.js process launched in the terminal',
	),
	[State.Smart]: localize(
		'debug.javascript.autoAttach.smart.description',
		"Auto attach when running scripts that aren't in a node_modules folder",
	),
	[State.OnlyWithFlag]: localize(
		'debug.javascript.autoAttach.onlyWithFlag.description',
		'Only auto attach when the `--inspect` flag is given',
	),
};
const TEXT_TOGGLE_WORKSPACE = localize('scope.workspace', 'Toggle auto attach in this workspace');
const TEXT_TOGGLE_GLOBAL = localize('scope.global', 'Toggle auto attach on this machine');

const TOGGLE_COMMAND = 'extension.node-debug.toggleAutoAttach';
const STORAGE_IPC = 'jsDebugIpcState';

const SETTING_SECTION = 'debug.javascript';
const SETTING_STATE = 'autoAttachFilter';

/**
 * settings that, when changed, should cause us to refresh the state vars
 */
const SETTINGS_CAUSE_REFRESH = new Set(
	['autoAttachSmartPattern', SETTING_STATE].map(s => `${SETTING_SECTION}.${s}`),
);

const enum State {
	Disabled = 'disabled',
	OnlyWithFlag = 'onlyWithFlag',
	Smart = 'smart',
	Always = 'always',
}

let currentState: Promise<{ context: vscode.ExtensionContext; state: State | null }>;
let statusItem: vscode.StatusBarItem | undefined; // and there is no status bar item
let server: Promise<Server | undefined> | undefined; // auto attach server

export function activate(context: vscode.ExtensionContext): void {
	currentState = Promise.resolve({ context, state: null });

	context.subscriptions.push(
		vscode.commands.registerCommand(TOGGLE_COMMAND, toggleAutoAttachSetting),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			// Whenever a setting is changed, disable auto attach, and re-enable
			// it (if necessary) to refresh variables.
			if (
				e.affectsConfiguration(`${SETTING_SECTION}.${SETTING_STATE}`) ||
				[...SETTINGS_CAUSE_REFRESH].some(setting => e.affectsConfiguration(setting))
			) {
				updateAutoAttach(State.Disabled);
				updateAutoAttach(readCurrentState());
			}
		}),
	);

	updateAutoAttach(readCurrentState());
}

export async function deactivate(): Promise<void> {
	await destroyAttachServer();
}

function getDefaultScope(info: ReturnType<vscode.WorkspaceConfiguration['inspect']>) {
	if (!info) {
		return vscode.ConfigurationTarget.Global;
	} else if (info.workspaceFolderValue) {
		return vscode.ConfigurationTarget.WorkspaceFolder;
	} else if (info.workspaceValue) {
		return vscode.ConfigurationTarget.Workspace;
	} else if (info.globalValue) {
		return vscode.ConfigurationTarget.Global;
	}

	return vscode.ConfigurationTarget.Global;
}

type PickResult = { state: State } | { scope: vscode.ConfigurationTarget } | undefined;

async function toggleAutoAttachSetting(scope?: vscode.ConfigurationTarget): Promise<void> {
	const section = vscode.workspace.getConfiguration(SETTING_SECTION);
	scope = scope || getDefaultScope(section.inspect(SETTING_STATE));

	const isGlobalScope = scope === vscode.ConfigurationTarget.Global;
	const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { state: State }>();
	const current = readCurrentState();

	quickPick.items = [State.Always, State.Smart, State.OnlyWithFlag, State.Disabled].map(state => ({
		state,
		label: TEXT_STATE_LABEL[state],
		description: TEXT_STATE_DESCRIPTION[state],
		alwaysShow: true,
	}));

	quickPick.activeItems = quickPick.items.filter(i => i.state === current);
	quickPick.title = isGlobalScope ? TEXT_TOGGLE_GLOBAL : TEXT_TOGGLE_WORKSPACE;
	quickPick.buttons = [
		{
			iconPath: new vscode.ThemeIcon(isGlobalScope ? 'folder' : 'globe'),
			tooltip: isGlobalScope ? TEXT_TOGGLE_WORKSPACE : TEXT_TOGGLE_GLOBAL,
		},
	];

	quickPick.show();

	const result = await new Promise<PickResult>(resolve => {
		quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
		quickPick.onDidHide(() => resolve(undefined));
		quickPick.onDidTriggerButton(() => {
			resolve({
				scope: isGlobalScope
					? vscode.ConfigurationTarget.Workspace
					: vscode.ConfigurationTarget.Global,
			});
		});
	});

	quickPick.dispose();

	if (!result) {
		return;
	}

	if ('scope' in result) {
		return await toggleAutoAttachSetting(result.scope);
	}

	if ('state' in result) {
		section.update(SETTING_STATE, result.state, scope);
	}
}

function readCurrentState(): State {
	const section = vscode.workspace.getConfiguration(SETTING_SECTION);
	return section.get<State>(SETTING_STATE) ?? State.Disabled;
}

/**
 * Makes sure the status bar exists and is visible.
 */
function ensureStatusBarExists(context: vscode.ExtensionContext) {
	if (!statusItem) {
		statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		statusItem.command = TOGGLE_COMMAND;
		statusItem.tooltip = localize(
			'status.tooltip.auto.attach',
			'Automatically attach to node.js processes in debug mode',
		);
		statusItem.show();
		context.subscriptions.push(statusItem);
	} else {
		statusItem.show();
	}

	return statusItem;
}

async function clearJsDebugAttachState(context: vscode.ExtensionContext) {
	await context.workspaceState.update(STORAGE_IPC, undefined);
	await vscode.commands.executeCommand('extension.js-debug.clearAutoAttachVariables');
	await destroyAttachServer();
}

/**
 * Turns auto attach on, and returns the server auto attach is listening on
 * if it's successful.
 */
async function createAttachServer(context: vscode.ExtensionContext) {
	const ipcAddress = await getIpcAddress(context);
	if (!ipcAddress) {
		return undefined;
	}

	server = createServerInner(ipcAddress).catch(err => {
		console.error(err);
		return undefined;
	});

	return await server;
}

const createServerInner = async (ipcAddress: string) => {
	try {
		return await createServerInstance(ipcAddress);
	} catch (e) {
		// On unix/linux, the file can 'leak' if the process exits unexpectedly.
		// If we see this, try to delete the file and then listen again.
		await fs.unlink(ipcAddress).catch(() => undefined);
		return await createServerInstance(ipcAddress);
	}
};

const createServerInstance = (ipcAddress: string) =>
	new Promise<Server>((resolve, reject) => {
		const s = createServer(socket => {
			let data: Buffer[] = [];
			socket.on('data', async chunk => {
				if (chunk[chunk.length - 1] !== 0) {
					// terminated with NUL byte
					data.push(chunk);
					return;
				}

				data.push(chunk.slice(0, -1));

				try {
					await vscode.commands.executeCommand(
						'extension.js-debug.autoAttachToProcess',
						JSON.parse(Buffer.concat(data).toString()),
					);
					socket.write(Buffer.from([0]));
				} catch (err) {
					socket.write(Buffer.from([1]));
					console.error(err);
				}
			});
		})
			.on('error', reject)
			.listen(ipcAddress, () => resolve(s));
	});

/**
 * Destroys the auto-attach server, if it's running.
 */
async function destroyAttachServer() {
	const instance = await server;
	if (instance) {
		await new Promise(r => instance.close(r));
	}
}

interface CachedIpcState {
	ipcAddress: string;
	jsDebugPath: string;
	settingsValue: string;
}

/**
 * Map of logic that happens when auto attach states are entered and exited.
 * All state transitions are queued and run in order; promises are awaited.
 */
const transitions: { [S in State]: (context: vscode.ExtensionContext) => Promise<void> } = {
	async [State.Disabled](context) {
		await clearJsDebugAttachState(context);
		statusItem?.hide();
	},

	async [State.OnlyWithFlag](context) {
		await createAttachServer(context);
		const statusItem = ensureStatusBarExists(context);
		statusItem.text = TEXT_WITH_FLAG;
	},

	async [State.Smart](context) {
		await createAttachServer(context);
		const statusItem = ensureStatusBarExists(context);
		statusItem.text = TEXT_SMART;
	},

	async [State.Always](context) {
		await createAttachServer(context);
		const statusItem = ensureStatusBarExists(context);
		statusItem.text = TEXT_ALWAYS;
	},
};

/**
 * Updates the auto attach feature based on the user or workspace setting
 */
function updateAutoAttach(newState: State) {
	currentState = currentState.then(async ({ context, state: oldState }) => {
		if (newState === oldState) {
			return { context, state: oldState };
		}

		await transitions[newState](context);
		return { context, state: newState };
	});
}

/**
 * Gets the IPC address for the server to listen on for js-debug sessions. This
 * is cached such that we can reuse the address of previous activations.
 */
async function getIpcAddress(context: vscode.ExtensionContext) {
	// Iff the `cachedData` is present, the js-debug registered environment
	// variables for this workspace--cachedData is set after successfully
	// invoking the attachment command.
	const cachedIpc = context.workspaceState.get<CachedIpcState>(STORAGE_IPC);

	// We invalidate the IPC data if the js-debug path changes, since that
	// indicates the extension was updated or reinstalled and the
	// environment variables will have been lost.
	// todo: make a way in the API to read environment data directly without activating js-debug?
	const jsDebugPath =
		vscode.extensions.getExtension('ms-vscode.js-debug-nightly')?.extensionPath ||
		vscode.extensions.getExtension('ms-vscode.js-debug')?.extensionPath;

	const settingsValue = getJsDebugSettingKey();
	if (cachedIpc?.jsDebugPath === jsDebugPath && cachedIpc?.settingsValue === settingsValue) {
		return cachedIpc.ipcAddress;
	}

	const result = await vscode.commands.executeCommand<{ ipcAddress: string }>(
		'extension.js-debug.setAutoAttachVariables',
		cachedIpc?.ipcAddress,
	);
	if (!result) {
		return;
	}

	const ipcAddress = result.ipcAddress;
	await context.workspaceState.update(STORAGE_IPC, {
		ipcAddress,
		jsDebugPath,
		settingsValue,
	} as CachedIpcState);

	return ipcAddress;
}

function getJsDebugSettingKey() {
	let o: { [key: string]: unknown } = {};
	const config = vscode.workspace.getConfiguration(SETTING_SECTION);
	for (const setting of SETTINGS_CAUSE_REFRESH) {
		o[setting] = config.get(setting);
	}

	return JSON.stringify(o);
}
