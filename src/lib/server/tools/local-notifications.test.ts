import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	defineLocalNotificationTools,
	escapeAppleScriptString,
	imessageSendInput,
	isMacOs,
	notifyUserInput,
	sendIMessage,
	sendUserNotification
} from './local-notifications';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
	setPlatform(originalPlatform);
	vi.restoreAllMocks();
});

// ── escapeAppleScriptString ───────────────────────────────────────────────────

describe('escapeAppleScriptString', () => {
	it('escapes double quotes', () => {
		expect(escapeAppleScriptString('say "hello"')).toBe('say \\"hello\\"');
	});

	it('escapes backslashes before quotes so escaping is not double-applied', () => {
		expect(escapeAppleScriptString('a\\b')).toBe('a\\\\b');
		expect(escapeAppleScriptString('a\\"b')).toBe('a\\\\\\"b');
	});

	it('collapses raw newlines to a space', () => {
		expect(escapeAppleScriptString('line one\nline two')).toBe('line one line two');
		expect(escapeAppleScriptString('line one\r\nline two')).toBe('line one line two');
	});

	it('neutralizes an attempted AppleScript injection via `do shell script`', () => {
		const malicious = '" & do shell script "rm -rf ~" & "';
		const escaped = escapeAppleScriptString(malicious);

		// Every double quote must be escaped, so the payload cannot break out of
		// the surrounding string literal — it must remain inert text.
		expect(escaped).not.toMatch(/(?<!\\)"/);
		expect(escaped).toBe('\\" & do shell script \\"rm -rf ~\\" & \\"');
	});

	it('is a no-op for plain text', () => {
		expect(escapeAppleScriptString('hello world')).toBe('hello world');
	});
});

// ── isMacOs ────────────────────────────────────────────────────────────────────

describe('isMacOs', () => {
	it('returns true on darwin', () => {
		setPlatform('darwin');
		expect(isMacOs()).toBe(true);
	});

	it('returns false on non-darwin platforms', () => {
		setPlatform('linux');
		expect(isMacOs()).toBe(false);
	});
});

// ── sendUserNotification ──────────────────────────────────────────────────────

describe('sendUserNotification', () => {
	beforeEach(() => setPlatform('darwin'));

	it('throws on non-macOS platforms without invoking the runner', async () => {
		setPlatform('linux');
		const run = vi.fn().mockResolvedValue({ stdout: '' });

		await expect(sendUserNotification({ title: 'Hi', message: 'Hello' }, { run })).rejects.toThrow(
			/macOS/
		);
		expect(run).not.toHaveBeenCalled();
	});

	it('invokes osascript with an escaped display notification script', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });

		await sendUserNotification(
			{ title: 'Stardust needs approval', message: 'shell.exec is waiting for your approval' },
			{ run }
		);

		expect(run).toHaveBeenCalledTimes(1);
		const [file, args] = run.mock.calls[0] as [string, string[]];
		expect(file).toBe('osascript');
		expect(args).toEqual([
			'-e',
			'display notification "shell.exec is waiting for your approval" with title "Stardust needs approval"'
		]);
	});

	it('includes an escaped subtitle when provided', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });

		await sendUserNotification(
			{ title: 'Title', message: 'Body', subtitle: 'Sub "title"' },
			{ run }
		);

		const [, args] = run.mock.calls[0] as [string, string[]];
		expect(args[1]).toContain('subtitle "Sub \\"title\\""');
	});

	it('escapes injection attempts in title and message', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });
		const malicious = '" & do shell script "rm -rf ~" & "';
		const escaped = escapeAppleScriptString(malicious);

		await sendUserNotification({ title: malicious, message: malicious }, { run });

		const [, args] = run.mock.calls[0] as [string, string[]];
		// The whole payload stays confined to a single `-e` script line — it never
		// grows extra `-e` flags (which would mean the injection escaped the string
		// literal and added new AppleScript statements).
		expect(args).toHaveLength(2);
		const script = args[1] ?? '';
		expect(script).toBe(`display notification "${escaped}" with title "${escaped}"`);
	});

	it('returns an ISO sentAt timestamp', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });
		const result = await sendUserNotification({ title: 'Title', message: 'Body' }, { run });
		expect(new Date(result.sentAt).toISOString()).toBe(result.sentAt);
	});
});

// ── sendIMessage ───────────────────────────────────────────────────────────────

describe('sendIMessage', () => {
	beforeEach(() => setPlatform('darwin'));

	it('throws on non-macOS platforms without invoking the runner', async () => {
		setPlatform('linux');
		const run = vi.fn().mockResolvedValue({ stdout: '' });

		await expect(
			sendIMessage({ recipient: 'friend@example.com', message: 'hi' }, { run })
		).rejects.toThrow(/macOS/);
		expect(run).not.toHaveBeenCalled();
	});

	it('invokes osascript with the expected Messages.app AppleScript', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });

		await sendIMessage({ recipient: 'friend@example.com', message: 'hello there' }, { run });

		expect(run).toHaveBeenCalledTimes(1);
		const [file, args] = run.mock.calls[0] as [string, string[]];
		expect(file).toBe('osascript');
		expect(args).toEqual([
			'-e',
			'tell application "Messages"',
			'-e',
			'set targetService to 1st account whose service type = iMessage',
			'-e',
			'set targetBuddy to participant "friend@example.com" of targetService',
			'-e',
			'send "hello there" to targetBuddy',
			'-e',
			'end tell'
		]);
	});

	it('escapes injection attempts in the recipient and message', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });
		const malicious = '" & do shell script "rm -rf ~" & "';
		const escaped = escapeAppleScriptString(malicious);

		await sendIMessage({ recipient: malicious, message: malicious }, { run });

		const [, args] = run.mock.calls[0] as [string, string[]];
		// Still exactly five `-e` script lines (one per AppleScript statement) — the
		// injection payload never breaks out to add or remove statements.
		expect(args).toEqual([
			'-e',
			'tell application "Messages"',
			'-e',
			'set targetService to 1st account whose service type = iMessage',
			'-e',
			`set targetBuddy to participant "${escaped}" of targetService`,
			'-e',
			`send "${escaped}" to targetBuddy`,
			'-e',
			'end tell'
		]);
	});

	it('returns the original (unescaped) recipient and an ISO sentAt timestamp', async () => {
		const run = vi.fn().mockResolvedValue({ stdout: '' });
		const result = await sendIMessage({ recipient: 'friend@example.com', message: 'hi' }, { run });

		expect(result.recipient).toBe('friend@example.com');
		expect(new Date(result.sentAt).toISOString()).toBe(result.sentAt);
	});
});

// ── input schemas ────────────────────────────────────────────────────────────

describe('notifyUserInput', () => {
	it('accepts a valid payload with an optional subtitle', () => {
		expect(
			notifyUserInput.safeParse({ title: 'Title', message: 'Message', subtitle: 'Sub' }).success
		).toBe(true);
		expect(notifyUserInput.safeParse({ title: 'Title', message: 'Message' }).success).toBe(true);
	});

	it('rejects an empty title or message', () => {
		expect(notifyUserInput.safeParse({ title: '', message: 'Message' }).success).toBe(false);
		expect(notifyUserInput.safeParse({ title: 'Title', message: '' }).success).toBe(false);
	});

	it('rejects overlong fields', () => {
		expect(notifyUserInput.safeParse({ title: 'a'.repeat(121), message: 'Message' }).success).toBe(
			false
		);
		expect(notifyUserInput.safeParse({ title: 'Title', message: 'a'.repeat(501) }).success).toBe(
			false
		);
	});
});

describe('imessageSendInput', () => {
	it('accepts a valid payload', () => {
		expect(
			imessageSendInput.safeParse({ recipient: 'friend@example.com', message: 'hi' }).success
		).toBe(true);
	});

	it('rejects an empty recipient or message', () => {
		expect(imessageSendInput.safeParse({ recipient: '', message: 'hi' }).success).toBe(false);
		expect(
			imessageSendInput.safeParse({ recipient: 'friend@example.com', message: '' }).success
		).toBe(false);
	});

	it('rejects an overlong message', () => {
		expect(
			imessageSendInput.safeParse({ recipient: 'friend@example.com', message: 'a'.repeat(2001) })
				.success
		).toBe(false);
	});
});

// ── defineLocalNotificationTools ─────────────────────────────────────────────

describe('defineLocalNotificationTools', () => {
	it('registers notify.user as low-risk with no approval required', () => {
		const tools = defineLocalNotificationTools();
		const notify = tools.find((tool) => tool.name === 'notify.user');
		expect(notify).toBeDefined();
		expect(notify?.metadata).toMatchObject({ risk: 'low', requiresApproval: false });
	});

	it('registers imessage.send as high-risk requiring approval', () => {
		const tools = defineLocalNotificationTools();
		const imessage = tools.find((tool) => tool.name === 'imessage.send');
		expect(imessage).toBeDefined();
		expect(imessage?.metadata).toMatchObject({ risk: 'high', requiresApproval: true });
	});
});
