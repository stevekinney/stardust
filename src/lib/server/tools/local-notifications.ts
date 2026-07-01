import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { MESSAGING_TOOL, NOTIFY_TOOL } from '../policy/risk';
import { defineStardustTool } from './define-tool';
import type { RegisteredTool } from '../policy/policy-engine';

const execFileAsync = promisify(execFile);

/** Runs an external command with argv-array semantics, bypassing the shell. */
export type OsascriptRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** Whether the current process is running on macOS — required for `osascript`/Messages.app. */
export function isMacOs(): boolean {
	return process.platform === 'darwin';
}

/** Input schema for the `notify.user` tool. */
export const notifyUserInput = z.object({
	title: z.string().min(1).max(120),
	message: z.string().min(1).max(500),
	subtitle: z.string().max(120).optional()
});

/** Parsed input for `notify.user` / {@link sendUserNotification}. */
export type NotifyUserInput = z.infer<typeof notifyUserInput>;

/** Input schema for the `imessage.send` tool. */
export const imessageSendInput = z.object({
	recipient: z.string().min(1),
	message: z.string().min(1).max(2000)
});

/** Parsed input for `imessage.send` / {@link sendIMessage}. */
export type ImessageSendInput = z.infer<typeof imessageSendInput>;

/**
 * Escapes a string for safe interpolation into a double-quoted AppleScript string
 * literal. Backslashes must be escaped first (otherwise the escaping added for the
 * quote character would itself get re-escaped). Raw carriage returns and line feeds
 * are replaced with a space because AppleScript string literals cannot contain a
 * literal line break — passing one through unescaped would break the script (and,
 * combined with unescaped quotes, could be used to break out of the string entirely
 * and inject additional AppleScript statements, e.g. `do shell script`).
 */
export function escapeAppleScriptString(input: string): string {
	return input
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\r\n]+/g, ' ');
}

async function runOsascript(file: string, args: string[]): Promise<{ stdout: string }> {
	return execFileAsync(file, args);
}

/**
 * Shows a native macOS desktop notification via `osascript`/`display notification`.
 * Throws on non-macOS platforms. Accepts an injectable `run` dependency so tests
 * never actually shell out to `osascript`.
 */
export async function sendUserNotification(
	args: NotifyUserInput,
	deps: { run?: OsascriptRunner } = {}
): Promise<{ sentAt: string }> {
	if (!isMacOs()) {
		throw new Error('notify.user requires macOS (osascript is unavailable on this platform)');
	}
	const run = deps.run ?? runOsascript;

	const scriptLines = [
		`display notification "${escapeAppleScriptString(args.message)}" with title "${escapeAppleScriptString(args.title)}"${
			args.subtitle ? ` subtitle "${escapeAppleScriptString(args.subtitle)}"` : ''
		}`
	];

	await run(
		'osascript',
		scriptLines.flatMap((line) => ['-e', line])
	);

	return { sentAt: new Date().toISOString() };
}

/**
 * Sends a real iMessage through the user's Messages.app account via AppleScript.
 * Throws on non-macOS platforms. Accepts an injectable `run` dependency so tests
 * never actually send a message.
 */
export async function sendIMessage(
	args: ImessageSendInput,
	deps: { run?: OsascriptRunner } = {}
): Promise<{ recipient: string; sentAt: string }> {
	if (!isMacOs()) {
		throw new Error('imessage.send requires macOS (Messages.app is unavailable on this platform)');
	}
	const run = deps.run ?? runOsascript;

	const recipient = escapeAppleScriptString(args.recipient);
	const message = escapeAppleScriptString(args.message);
	const scriptLines = [
		'tell application "Messages"',
		'set targetService to 1st account whose service type = iMessage',
		`set targetBuddy to participant "${recipient}" of targetService`,
		`send "${message}" to targetBuddy`,
		'end tell'
	];

	await run(
		'osascript',
		scriptLines.flatMap((line) => ['-e', line])
	);

	return { recipient: args.recipient, sentAt: new Date().toISOString() };
}

/**
 * Registers the keyless macOS-local notification tools: `notify.user` (native
 * desktop notification, no approval required) and `imessage.send` (sends a real
 * iMessage from the user's own Messages account, so it requires approval).
 */
export function defineLocalNotificationTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'notify.user',
			description: 'Show a native macOS desktop notification to the user on this machine.',
			schema: notifyUserInput,
			metadata: NOTIFY_TOOL
		}),
		defineStardustTool({
			name: 'imessage.send',
			description:
				"Send a REAL iMessage from the user's own Messages account to a recipient. Requires approval.",
			schema: imessageSendInput,
			metadata: MESSAGING_TOOL
		})
	];
}
