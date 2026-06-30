export type ViewMode = 'operator' | 'engineer';

const STORAGE_KEY = 'stardust-view-mode';
const ALWAYS_ON_MODE: ViewMode = 'engineer';

/** Reactive store for the permanently enabled under-the-hood view. */
export class ViewModeStore {
	mode = $state<ViewMode>(ALWAYS_ON_MODE);

	constructor() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, ALWAYS_ON_MODE);
		}
	}

	set(): void {
		this.mode = ALWAYS_ON_MODE;
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, ALWAYS_ON_MODE);
		}
	}

	get isEngineer(): boolean {
		return true;
	}
}

export const viewMode = new ViewModeStore();
