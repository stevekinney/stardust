import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '$lib/stream-to-conversation';
import ConversationView, { chatAttachmentsToSessionAttachments } from './conversation-view.svelte';

function makeEvent(id: number, kind: string, payload: Record<string, unknown>): StreamEvent {
	return { id, kind, payload: JSON.stringify(payload) };
}

/**
 * Cinder's markdown rendering is deliberately async — it defers past a
 * requestAnimationFrame, then dynamically imports the rendering pipeline
 * (see `markdown-preview.svelte`). Poll until the predicate is true instead
 * of assuming a fixed number of ticks is enough.
 *
 * 20s default: under normal load the real work here is ~1s (one rAF frame
 * plus a cached dynamic import), but this suite runs alongside CPU-heavy
 * sibling test files (subprocess timeout tests, in-memory Temporal servers)
 * in the same run, and a tight timeout here flakes under that contention
 * rather than reflecting an actual hang.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor: timed out waiting for predicate');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const defaultProps = {
	sessionId: 'test-session',
	onSubmit: vi.fn()
};

describe('ConversationView', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the conversation container', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		const conversation = document.querySelector('[aria-label="Conversation"]');
		expect(conversation).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders the Cinder Chat component with the correct id', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		const chatContainer = document.querySelector('[id^="session-test-session"]');
		expect(chatContainer).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders lifecycle markers with custom row override', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'started' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run started"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('extends proxied event arrays through the fold cache without proxy-equality warnings', () => {
		const warnings: string[] = [];
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		});

		try {
			// Keep a RAW reference to the initial events: reassigning props.events by
			// spreading this raw array (as the session page does) puts raw objects in
			// the new array while the fold cache holds their $state-proxied twins from
			// the prop read — the exact identity mismatch this test guards against.
			const initialEvents = [makeEvent(1, 'lifecycle', { status: 'started' })];
			const props = $state({ ...defaultProps, events: initialEvents });
			const component = mount(ConversationView, { target: document.body, props });
			flushSync();

			props.events = [...initialEvents, makeEvent(2, 'lifecycle', { status: 'complete' })];
			flushSync();

			expect(document.querySelector('[aria-label="Run started"]')).toBeInstanceOf(HTMLElement);
			expect(document.querySelector('[aria-label="Run complete"]')).toBeInstanceOf(HTMLElement);
			expect(warnings.filter((w) => w.includes('state_proxy_equality_mismatch'))).toEqual([]);

			unmount(component);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('renders lifecycle complete marker', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'complete' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run complete"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders lifecycle failed marker with reason', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'lifecycle', { status: 'failed', reason: 'Timeout exceeded' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run failed"]');
		expect(marker).toBeInstanceOf(HTMLElement);
		expect(marker!.textContent).toContain('Timeout exceeded');

		unmount(component);
	});

	it('renders subagent lanes', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'subagent.start', {
				subagentRunId: 'sub-001',
				kind: 'research',
				label: 'Research: climate change'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const lane = document.querySelector('[aria-label="Subagent: Research: climate change"]');
		expect(lane).toBeInstanceOf(HTMLElement);
		expect(lane!.textContent).toContain('research');

		unmount(component);
	});

	it('renders approval notices', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', {
				approvalId: 'apr-001',
				toolName: 'shell.exec'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const notice = document.querySelector('[aria-label="Approval required: shell.exec"]');
		expect(notice).toBeInstanceOf(HTMLElement);
		expect(notice!.textContent).toContain('shell.exec');

		unmount(component);
	});

	it('renders memory candidate notices', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'memory.candidate', { content: 'User prefers dark theme' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const notice = document.querySelector('[aria-label="Memory candidate"]');
		expect(notice).toBeInstanceOf(HTMLElement);
		expect(notice!.textContent).toContain('User prefers dark theme');

		unmount(component);
	});

	it('renders a retry button on failed lifecycle when onRetry is provided', () => {
		const onRetry = vi.fn();
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events, onRetry }
		});

		const button = document.querySelector('.lifecycle-retry') as HTMLButtonElement;
		expect(button).toBeInstanceOf(HTMLElement);
		button.click();
		expect(onRetry).toHaveBeenCalledOnce();

		unmount(component);
	});

	it('does not render a retry button when onRetry is not provided', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		expect(document.querySelector('.lifecycle-retry')).toBeNull();

		unmount(component);
	});

	it('renders an inline ApprovalCard for a pending approval and resolves through it', () => {
		const onResolveApproval = vi.fn();
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git push origin main' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval
			}
		});

		expect(document.body.textContent).toContain('git push origin main');
		expect(document.body.textContent).toContain('the same durable signal');

		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		expect(approveButton).toBeDefined();
		approveButton!.click();
		expect(onResolveApproval).toHaveBeenCalledWith('apr-001', 'approve');

		unmount(component);
	});

	it('BUG-004: announces a pending inline approval in a dedicated polite live region', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git push origin main' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval: vi.fn()
			}
		});

		const announcer = Array.from(
			document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')
		).find((region) => region.textContent?.includes('Approval required'));
		expect(announcer).toBeInstanceOf(HTMLElement);
		expect(announcer!.textContent).toContain('Approval required: run_command');

		unmount(component);
	});

	it('preserves edited arguments from the inline ApprovalCard', async () => {
		const onResolveApproval = vi.fn();
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git status' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval
			}
		});

		const editButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve with edits'
		);
		expect(editButton).toBeDefined();
		editButton!.click();
		await Promise.resolve();

		const textarea = document.querySelector('textarea') as HTMLTextAreaElement | null;
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		textarea!.value = JSON.stringify({ command: 'git status --short' });
		textarea!.dispatchEvent(new Event('input', { bubbles: true }));

		const confirmButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Confirm edited approval'
		);
		expect(confirmButton).toBeDefined();
		confirmButton!.click();
		await Promise.resolve();

		expect(onResolveApproval).toHaveBeenCalledWith('apr-001', 'approve_with_edits', {
			command: 'git status --short'
		});

		unmount(component);
	});

	it('renders canonical approval requests with the nested toolCall name and settles on resolution', () => {
		const events: StreamEvent[] = [
			{
				...makeEvent(1, 'approval.request', {
					approvalId: 'apr-002',
					toolCall: { id: 'call-9', name: 'workspace.writeFile', arguments: {} }
				}),
				sequence: 5
			},
			{
				...makeEvent(2, 'approval.resolution', { approvalId: 'apr-002', action: 'approve' }),
				sequence: 6
			}
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		expect(document.body.textContent).toContain(
			'Approved — the signal woke the workflow and workspace.writeFile ran'
		);
		expect(document.body.textContent).not.toContain('Waiting for approval');

		unmount(component);
	});

	it('renders a settled banner after the approval is resolved', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: null,
				approvalResolution: 'approve' as const,
				onResolveApproval: vi.fn()
			}
		});

		expect(document.body.textContent).toContain('Approved — the signal woke the workflow');

		unmount(component);
	});

	it('does not render an edit affordance on user messages when onEdit is not provided', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [], userMessage: { text: 'Fix the login bug' } }
		});

		expect(document.querySelector('.chat-message-edit-button')).toBeNull();

		unmount(component);
	});

	it('renders an edit affordance on user messages when onEdit is provided, and submits the edited text as a new turn', async () => {
		const onEdit = vi.fn();
		const onSubmit = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				onSubmit,
				events: [],
				userMessage: { text: 'Fix the login bug' },
				onEdit
			}
		});

		const editButton = document.querySelector('.chat-message-edit-button') as HTMLButtonElement;
		expect(editButton).toBeInstanceOf(HTMLElement);
		editButton.click();
		await Promise.resolve();

		const textarea = document.querySelector(
			'.chat-message-edit-textarea'
		) as HTMLTextAreaElement | null;
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		textarea!.value = 'Fix the login bug — also check the session cookie';
		textarea!.dispatchEvent(new Event('input', { bubbles: true }));

		const saveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Save & Resend'
		);
		expect(saveButton).toBeDefined();
		saveButton!.click();
		await Promise.resolve();

		expect(onEdit).toHaveBeenCalledWith('Fix the login bug — also check the session cookie');
		// The original message is durable/append-only — editing does not call onSubmit,
		// it's the session page's job to resubmit onEdit's content as a new turn.
		expect(onSubmit).not.toHaveBeenCalled();
		// Cinder's own edit-mode state closes after save — no dangling textarea.
		expect(document.querySelector('.chat-message-edit-textarea')).toBeNull();

		unmount(component);
	});

	it('renders the attachment picker (attachments capability is enabled)', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		expect(document.querySelector('input[type="file"]')).toBeInstanceOf(HTMLInputElement);

		unmount(component);
	});

	it('renders an inline image preview for the current turn when userMessage carries an image attachment', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events: [],
				userMessage: {
					text: 'Check this screenshot',
					attachments: [
						{ name: 'bug.png', mimeType: 'image/png', kind: 'image' as const, content: 'QUJD' }
					]
				}
			}
		});

		const image = document.querySelector('img[src^="data:image/png;base64,QUJD"]');
		expect(image).toBeInstanceOf(HTMLImageElement);

		unmount(component);
	});

	describe('chatAttachmentsToSessionAttachments', () => {
		it('base64-encodes each attachment file and preserves name/mimeType/kind', async () => {
			const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
			const result = await chatAttachmentsToSessionAttachments([
				{
					id: 'att-1',
					file,
					previewUrl: 'blob:fake',
					kind: 'document',
					status: 'ready'
				}
			]);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('notes.txt');
			expect(result[0].mimeType).toBe('text/plain');
			expect(result[0].kind).toBe('document');
			expect(atob(result[0].content)).toBe('hello world');
		});

		it('falls back to application/octet-stream when the file has no MIME type', async () => {
			const file = new File(['data'], 'blob', { type: '' });
			const result = await chatAttachmentsToSessionAttachments([
				{ id: 'att-2', file, previewUrl: 'blob:fake', kind: 'document', status: 'ready' }
			]);

			expect(result[0].mimeType).toBe('application/octet-stream');
		});
	});

	it('dims rows whose durable sequence is past the replay cursor', () => {
		const events: StreamEvent[] = [
			{ ...makeEvent(1, 'lifecycle', { status: 'started' }), sequence: 2 },
			{ ...makeEvent(2, 'lifecycle', { status: 'complete' }), sequence: 6 }
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events, dimAfterSequence: 3 }
		});

		const dimmed = document.querySelectorAll('.row-dimmed');
		expect(dimmed).toHaveLength(1);
		expect(dimmed[0].textContent).toContain('Run complete');

		unmount(component);
	});

	// ── XSS: hostile text in tool output / model text must never execute or
	// produce a live dangerous element. Cinder's markdown pipeline sanitizes
	// via rehype-sanitize + URL allowlisting (see
	// /Users/stevekinney/Developer/cinder/packages/markdown/src/rendering/render.ts);
	// these tests exercise that pipeline end-to-end through Stardust's own
	// stream -> ConversationView path rather than trusting it by inspection alone.

	describe('XSS in tool output and assistant text', () => {
		/**
		 * Mounts into a fresh, isolated container per test (rather than
		 * `document.body` directly) so assertions can't accidentally match
		 * unrelated markup the Vitest browser harness injects into the page
		 * (e.g. its own bootstrap `<script>` tags).
		 */
		function mountInIsolatedContainer(events: StreamEvent[]) {
			const container = document.createElement('div');
			document.body.appendChild(container);
			const component = mount(ConversationView, {
				target: container,
				props: { ...defaultProps, events }
			});
			return {
				container,
				cleanup: () => {
					unmount(component);
					container.remove();
				}
			};
		}

		it('neutralizes a raw <img onerror> payload in assistant markdown', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'assistant.message', {
					text: 'before <img src=x onerror=alert(1)> after'
				})
			]);

			// Before the async markdown pipeline resolves, MarkdownPreview shows a
			// plain-text fallback (`<p>{content}</p>`) that still contains the
			// escaped raw source. Wait for that raw source to be gone — i.e. for
			// the sanitized render (which strips the whole raw-HTML node) to land
			// — so the assertions below exercise the real sanitizer, not the
			// merely-coincidentally-safe fallback.
			await waitFor(() => !container.innerHTML.includes('onerror'));

			expect(container.querySelector('img')).toBeNull();
			expect(container.querySelector('[onerror]')).toBeNull();

			cleanup();
		});

		it('neutralizes a raw <script> payload in assistant markdown', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'assistant.message', {
					text: 'before <script>window.__xss = true;</script> after'
				})
			]);

			// The fallback shows the raw source with its angle brackets HTML-escaped
			// (`&lt;script&gt;...&lt;/script&gt;`). The sanitized render strips the
			// whole raw-HTML tag nodes, leaving only the inert inner text — so
			// waiting for the escaped opening tag to disappear reliably detects
			// that the real (not fallback) render has landed. The inner text
			// itself ("window.__xss = true;") is expected to remain, as inert
			// prose — it was never inside a live <script> element.
			await waitFor(() => !container.innerHTML.includes('&lt;script&gt;'));

			expect(container.querySelector('script')).toBeNull();
			expect((globalThis as { __xss?: boolean }).__xss).toBeUndefined();

			cleanup();
		});

		it('neutralizes a javascript: URL in a markdown link', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'assistant.message', {
					text: '[click me](javascript:alert(document.cookie))'
				})
			]);

			// The fallback shows the raw, un-rendered markdown source
			// (`[click me](javascript:...)`) until the async pipeline resolves.
			// Wait for that literal bracket syntax to be replaced by a real
			// element before asserting on the link's href.
			await waitFor(() => !container.innerHTML.includes('(javascript:'));

			const link = Array.from(container.querySelectorAll('a')).find((anchor) =>
				anchor.textContent?.includes('click me')
			);
			expect(link).toBeDefined();
			expect(link!.getAttribute('href')).not.toMatch(/^javascript:/i);

			cleanup();
		});

		it('neutralizes a javascript: URL in a markdown image', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'assistant.message', {
					text: '![alt text](javascript:alert(document.cookie))'
				})
			]);

			await waitFor(() => !container.innerHTML.includes('(javascript:'));

			// An unsafe image src is sanitized to an empty string upstream
			// (see Cinder's transformUrls), which rehype-sanitize/stringify may
			// then drop the <img> entirely rather than emit `src=""`. Either
			// outcome is safe; a live javascript: src is the only failure mode.
			const image = container.querySelector('img');
			expect(image === null || !/^javascript:/i.test(image.getAttribute('src') ?? '')).toBe(true);

			cleanup();
		});

		it('renders HTML markup inside a fenced code block as inert text, not live elements', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'assistant.message', {
					text: 'Here is an example:\n\n```html\n<script>alert(1)</script>\n```'
				})
			]);

			// Wait for the raw triple-backtick fence to be replaced by a real
			// <pre><code> block before asserting.
			await waitFor(() => !container.innerHTML.includes('```html'));

			expect(container.querySelector('script')).toBeNull();
			// The literal text must still be visible (escaped), proving it rendered
			// as code content rather than being silently dropped.
			expect(container.textContent).toContain('alert(1)');

			cleanup();
		});

		it('neutralizes a hostile tool.result payload containing raw HTML', async () => {
			const { container, cleanup } = mountInIsolatedContainer([
				makeEvent(1, 'tool.call', {
					id: 'tc-1',
					name: 'web.fetch',
					input: { url: 'https://example.test' }
				}),
				makeEvent(2, 'tool.result', {
					callId: 'tc-1',
					content: '<img src=x onerror=alert(document.cookie)>',
					isError: false
				})
			]);

			await waitFor(() => (container.textContent?.length ?? 0) > 0);

			// Tool-result content renders through ToolPayloadCode (JSON-stringified,
			// syntax-highlighted text) — never through the markdown/HTML pipeline —
			// so there must be no live <img> element and no onerror attribute
			// anywhere in the rendered tree.
			expect(container.querySelector('img')).toBeNull();
			expect(container.querySelector('[onerror]')).toBeNull();

			cleanup();
		});
	});
});
