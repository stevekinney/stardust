import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';

function getTextarea(label: string): HTMLTextAreaElement {
	const el = Array.from(document.querySelectorAll('textarea')).find(
		(candidate) => candidate.getAttribute('aria-label') === label
	);
	expect(el).toBeInstanceOf(HTMLTextAreaElement);
	return el as HTMLTextAreaElement;
}

function getButton(label: string): HTMLButtonElement {
	const el = Array.from(document.querySelectorAll('button')).find(
		(candidate) =>
			candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
	);
	expect(el).toBeInstanceOf(HTMLButtonElement);
	return el as HTMLButtonElement;
}

function findButton(label: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll('button')).find(
		(candidate) =>
			candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
	) as HTMLButtonElement | undefined;
}

describe('Composer', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders a message textarea and a send button', () => {
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit: vi.fn() }
		});

		const textarea = document.querySelector('textarea[aria-label="Message"]');
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		const sendButton = findButton('Send');
		expect(sendButton).toBeInstanceOf(HTMLButtonElement);

		unmount(component);
	});

	it('calls onSubmit with the trimmed message and clears the input', () => {
		const messages: string[] = [];
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit: (msg: string) => messages.push(msg) }
		});

		const input = getTextarea('Message');
		input.value = '  hello world  ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		getButton('Send').click();
		flushSync();

		expect(messages).toEqual(['hello world']);
		expect(input.value).toBe('');

		unmount(component);
	});

	it('does not call onSubmit when the message is empty', () => {
		const onSubmit = vi.fn();
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit }
		});

		getButton('Send').click();
		flushSync();

		expect(onSubmit).not.toHaveBeenCalled();

		unmount(component);
	});

	it('does not call onSubmit when the message is whitespace only', () => {
		const onSubmit = vi.fn();
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit }
		});

		const input = getTextarea('Message');
		input.value = '   ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		getButton('Send').click();
		flushSync();

		expect(onSubmit).not.toHaveBeenCalled();

		unmount(component);
	});

	it('disables the send button when disabled prop is true', () => {
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit: vi.fn(), disabled: true }
		});

		expect(getButton('Send').disabled).toBe(true);

		unmount(component);
	});

	it('does not call onSubmit when disabled even with message text', () => {
		const onSubmit = vi.fn();
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit, disabled: true }
		});

		const input = getTextarea('Message');
		input.value = 'hello';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		getButton('Send').click();
		flushSync();

		expect(onSubmit).not.toHaveBeenCalled();

		unmount(component);
	});

	it('submits on Enter key (without shift)', () => {
		const messages: string[] = [];
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit: (msg: string) => messages.push(msg) }
		});

		const input = getTextarea('Message');
		input.value = 'sent via keyboard';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();

		expect(messages).toEqual(['sent via keyboard']);

		unmount(component);
	});

	it('does not submit on Shift+Enter', () => {
		const onSubmit = vi.fn();
		const component = mount(Composer, {
			target: document.body,
			props: { onSubmit }
		});

		const input = getTextarea('Message');
		input.value = 'multiline draft';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
		);
		flushSync();

		expect(onSubmit).not.toHaveBeenCalled();

		unmount(component);
	});

	it('shows the interrupt button when running=true and onInterrupt is provided', () => {
		const component = mount(Composer, {
			target: document.body,
			props: {
				onSubmit: vi.fn(),
				onInterrupt: vi.fn(),
				running: true
			}
		});

		expect(findButton('Interrupt')).toBeInstanceOf(HTMLButtonElement);

		unmount(component);
	});

	it('calls onInterrupt when the interrupt button is clicked', () => {
		const onInterrupt = vi.fn();
		const component = mount(Composer, {
			target: document.body,
			props: {
				onSubmit: vi.fn(),
				onInterrupt,
				running: true
			}
		});

		getButton('Interrupt').click();
		flushSync();

		expect(onInterrupt).toHaveBeenCalledOnce();

		unmount(component);
	});

	it('does not show the interrupt button when running=false', () => {
		const component = mount(Composer, {
			target: document.body,
			props: {
				onSubmit: vi.fn(),
				onInterrupt: vi.fn(),
				running: false
			}
		});

		expect(findButton('Interrupt')).toBeUndefined();

		unmount(component);
	});

	it('shows the steer button when running=true and onSteer is provided', () => {
		const component = mount(Composer, {
			target: document.body,
			props: {
				onSubmit: vi.fn(),
				onSteer: vi.fn(),
				running: true
			}
		});

		expect(findButton('Steer')).toBeInstanceOf(HTMLButtonElement);

		unmount(component);
	});

	it('opens the steering panel and submits a steering message', () => {
		const steers: string[] = [];
		const component = mount(Composer, {
			target: document.body,
			props: {
				onSubmit: vi.fn(),
				onSteer: (msg: string) => steers.push(msg),
				running: true
			}
		});

		getButton('Steer').click();
		flushSync();

		const steerInput = getTextarea('Steering message');
		steerInput.value = 'focus on the third paragraph';
		steerInput.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		getButton('Send Steering').click();
		flushSync();

		expect(steers).toEqual(['focus on the third paragraph']);

		unmount(component);
	});
});
