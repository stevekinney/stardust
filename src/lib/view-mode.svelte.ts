export type ViewMode = 'operator' | 'engineer';

const STORAGE_KEY = 'stardust-view-mode';

class ViewModeStore {
	mode = $state<ViewMode>('operator');

	constructor() {
		if (typeof window !== 'undefined') {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved === 'operator' || saved === 'engineer') {
				this.mode = saved;
			}
		}
	}

	set(mode: ViewMode): void {
		this.mode = mode;
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, mode);
		}
	}

	get isEngineer(): boolean {
		return this.mode === 'engineer';
	}
}

export const viewMode = new ViewModeStore();
