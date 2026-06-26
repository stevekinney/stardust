<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import Drawer from '@lostgradient/cinder/drawer';
	import FormField from '@lostgradient/cinder/form-field';
	import Select from '@lostgradient/cinder/select';
	import SegmentedControl from '@lostgradient/cinder/segmented-control';
	import Segment from '@lostgradient/cinder/segment';
	import { viewMode, type ViewMode } from '$lib/view-mode.svelte';

	type Theme = 'system' | 'light' | 'dark';

	const SETTINGS_KEY = 'stardust-settings';

	type ModelId =
		| 'claude-sonnet-4-5-20250929'
		| 'claude-sonnet-4-6'
		| 'claude-opus-4-8'
		| 'claude-haiku-4-5-20251001';

	const MODEL_OPTIONS: Array<{ value: ModelId; label: string }> = [
		{ value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
		{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
		{ value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
		{ value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
	];

	function loadSettings() {
		if (typeof localStorage === 'undefined') {
			return { model: MODEL_OPTIONS[0].value, theme: 'system' as Theme, maxBudgetUsd: 5 };
		}
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) return JSON.parse(raw) as { model: ModelId; theme: Theme; maxBudgetUsd: number };
		} catch {
			// ignore parse errors
		}
		return { model: MODEL_OPTIONS[0].value, theme: 'system' as Theme, maxBudgetUsd: 5 };
	}

	function saveSettings() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ model, theme, maxBudgetUsd }));
		applyTheme(theme);
	}

	function applyTheme(t: Theme) {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		if (t === 'system') {
			root.removeAttribute('data-theme');
		} else {
			root.setAttribute('data-theme', t);
		}
	}

	function clearLocalData() {
		if (typeof localStorage === 'undefined') return;
		const confirmed = confirm(
			'This will clear all locally stored preferences and cached data. Continue?'
		);
		if (!confirmed) return;
		localStorage.clear();
		model = MODEL_OPTIONS[0].value;
		theme = 'system';
		maxBudgetUsd = 5;
		viewMode.set('operator');
		applyTheme('system');
	}

	const initial = loadSettings();

	let model = $state<ModelId>(initial.model);
	let theme = $state<Theme>(initial.theme);
	let maxBudgetUsd = $state(initial.maxBudgetUsd);
	let defaultView = $derived<ViewMode>(viewMode.mode);

	// Re-apply the persisted theme on mount so the preference survives page reloads.
	$effect(() => {
		applyTheme(theme);
	});

	type Props = {
		open?: boolean;
	};

	let { open = $bindable(false) }: Props = $props();

	function handleDefaultViewChange(value: string) {
		if (value === 'operator' || value === 'engineer') {
			viewMode.set(value);
		}
	}

	function handleSave() {
		saveSettings();
		open = false;
	}
</script>

<Drawer bind:open title="Settings" side="right" size="md">
	<div class="settings-body">
		<section class="settings-section" aria-labelledby="model-section-heading">
			<h3 id="model-section-heading" class="settings-section-title">Model &amp; Budget</h3>

			<Select id="model-select" label="Default Model" options={MODEL_OPTIONS} bind:value={model} />

			<FormField id="budget-input" label="Max budget per run (USD)">
				<input
					id="budget-input"
					type="number"
					min="0"
					step="0.5"
					class="budget-input"
					bind:value={maxBudgetUsd}
					aria-describedby="budget-hint"
				/>
				<p id="budget-hint" class="field-hint">
					Runs exceeding this cost will be halted. Set 0 to disable.
				</p>
			</FormField>
		</section>

		<section class="settings-section" aria-labelledby="appearance-section-heading">
			<h3 id="appearance-section-heading" class="settings-section-title">Appearance</h3>

			<div class="field-group">
				<span class="field-label" id="theme-label">Theme</span>
				<SegmentedControl
					id="theme-control"
					label="Theme"
					hideLabel
					value={theme}
					onchange={(value) => {
						theme = value as Theme;
					}}
				>
					<Segment value="system">System</Segment>
					<Segment value="light">Light</Segment>
					<Segment value="dark">Dark</Segment>
				</SegmentedControl>
			</div>

			<div class="field-group">
				<span class="field-label" id="view-label">Default view</span>
				<SegmentedControl
					id="default-view-control"
					label="Default view"
					hideLabel
					value={defaultView}
					onchange={handleDefaultViewChange}
				>
					<Segment value="operator">Operator</Segment>
					<Segment value="engineer">Engineer</Segment>
				</SegmentedControl>
			</div>
		</section>

		<section class="settings-section" aria-labelledby="data-section-heading">
			<h3 id="data-section-heading" class="settings-section-title">Local Data</h3>
			<p class="field-hint">Preferences and cached data are stored only in this browser.</p>
			<Button variant="soft-danger" label="Clear local data" onclick={clearLocalData} />
		</section>
	</div>

	{#snippet footer()}
		<div class="settings-footer">
			<Button variant="ghost" label="Cancel" onclick={() => (open = false)} />
			<Button variant="primary" label="Save settings" onclick={handleSave} />
		</div>
	{/snippet}
</Drawer>

<style>
	.settings-body {
		display: grid;
		gap: 2rem;
		padding: 1.5rem;
	}

	.settings-section {
		display: grid;
		gap: 1rem;
	}

	.settings-section-title {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in srgb, CanvasText 55%, transparent);
	}

	.field-group {
		display: grid;
		gap: 0.5rem;
	}

	.field-label {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.budget-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
		border-radius: 6px;
		background: Canvas;
		color: CanvasText;
		font: inherit;
		font-size: 0.875rem;
	}

	.budget-input:focus {
		outline: 2px solid var(--cinder-accent, #2563eb);
		outline-offset: 2px;
	}

	.field-hint {
		margin: 0;
		font-size: 0.8rem;
		color: color-mix(in srgb, CanvasText 55%, transparent);
	}

	.settings-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
	}
</style>
