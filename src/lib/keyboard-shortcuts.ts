/** A single keyboard shortcut entry for the shortcuts help dialog. */
export type KeyboardShortcut = {
	/** Key combination, rendered as one Kbd chip per entry (e.g. ['⌘', 'K']). */
	keys: string[];
	description: string;
};

/**
 * Data-driven list of the app's keyboard shortcuts, rendered by
 * `keyboard-shortcuts-dialog.svelte`. Kept as a plain array so other surfaces
 * (e.g. a slash-command layer) can extend it without touching the dialog.
 */
export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
	{ keys: ['⌘', 'K'], description: 'Open the command palette' },
	{ keys: ['?'], description: 'Show this keyboard shortcuts dialog' },
	{ keys: ['Enter'], description: 'Send a message' },
	{ keys: ['Shift', 'Enter'], description: 'Insert a newline in the message composer' },
	{ keys: ['Escape'], description: 'Close the command palette or an open dialog' },
	{ keys: ['↑', '↓'], description: 'Navigate results in the command palette' }
];
