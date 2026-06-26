import type { MemoryNote, MemorySearchResult } from './memory-store';

export function projectMemoryNotesToMarkdown(
	notes: readonly (MemoryNote | MemorySearchResult)[]
): string {
	if (notes.length === 0) {
		return '';
	}

	return notes
		.map((note) => {
			const tags = note.tags.length > 0 ? ` tags: ${note.tags.join(', ')}` : '';
			return `- [${note.layer}] ${note.content}${tags}`;
		})
		.join('\n');
}
