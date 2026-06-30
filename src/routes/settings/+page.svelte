<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import Select from '@lostgradient/cinder/select';
	import { viewMode, type ViewMode } from '$lib/view-mode.svelte';

	type Theme = 'system' | 'light' | 'dark';

	const SETTINGS_KEY = 'stardust-settings';

	type ModelId =
		| 'claude-sonnet-4-5-20250929'
		| 'claude-sonnet-4-6'
		| 'claude-opus-4-8'
		| 'claude-haiku-4-5-20251001';

	const MODEL_OPTIONS: Array<{ value: ModelId; label: string }> = [
		{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
		{ value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
		{ value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
		{ value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
	];

	const THEME_OPTIONS = [
		{ value: 'system', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];

	const VIEW_OPTIONS = [
		{ value: 'operator', label: 'Operator' },
		{ value: 'engineer', label: 'Engineer' }
	];

	function loadSettings() {
		if (typeof window === 'undefined') {
			return {
				model: MODEL_OPTIONS[0].value,
				theme: 'dark' as Theme,
				maxBudgetUsd: 5,
				tokensPerRun: 200000
			};
		}
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) {
				return JSON.parse(raw) as {
					model: ModelId;
					theme: Theme;
					maxBudgetUsd: number;
					tokensPerRun: number;
				};
			}
		} catch {
			// ignore
		}
		return {
			model: MODEL_OPTIONS[0].value,
			theme: 'dark' as Theme,
			maxBudgetUsd: 5,
			tokensPerRun: 200000
		};
	}

	function saveSettings() {
		if (typeof window === 'undefined') return;
		localStorage.setItem(
			SETTINGS_KEY,
			JSON.stringify({ model, theme, maxBudgetUsd, tokensPerRun })
		);
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
		if (typeof window === 'undefined') return;
		const confirmed = confirm(
			'This will delete the database, artifacts, workspaces, and model cache. Sessions, transcripts, memory, and schedules are gone. This cannot be undone.'
		);
		if (!confirmed) return;
		localStorage.clear();
		model = MODEL_OPTIONS[0].value;
		theme = 'dark';
		maxBudgetUsd = 5;
		tokensPerRun = 200000;
		viewMode.set('operator');
		applyTheme('dark');
	}

	const initial = loadSettings();

	let model = $state<ModelId>(initial.model);
	let theme = $state<Theme>(initial.theme);
	let maxBudgetUsd = $state(initial.maxBudgetUsd);
	let tokensPerRun = $state(initial.tokensPerRun);
	let defaultView = $derived<ViewMode>(viewMode.mode);

	$effect(() => {
		void [model, theme, maxBudgetUsd, tokensPerRun];
		saveSettings();
	});

	function handleDefaultViewChange(value: string) {
		if (value === 'operator' || value === 'engineer') {
			viewMode.set(value);
		}
	}
</script>

<svelte:head>
	<title>Settings — Stardust</title>
</svelte:head>

<div class="page">
	<PageHeader title="Settings" />

	<div class="page-body">
		<div class="settings-column">
			<section class="section">
				<div class="section-title">Model & provider</div>
				<div class="section-desc">
					The one unavoidable external call. Everything else runs locally.
				</div>
				<div class="section-fields">
					<Select id="model-select" label="Model" options={MODEL_OPTIONS} bind:value={model} />
				</div>
			</section>

			<div class="divider"></div>

			<section class="section">
				<div class="section-title">Budgets</div>
				<div class="section-desc">
					Hard caps per run. A run that would exceed its budget pauses for your approval to
					continue.
				</div>
				<div class="section-fields-grid">
					<div class="field">
						<label class="field-label" for="tokens-input">Tokens per run</label>
						<input
							id="tokens-input"
							type="number"
							min="0"
							step="10000"
							class="input"
							bind:value={tokensPerRun}
						/>
						<span class="field-desc">Soft-stop & ask to continue</span>
					</div>
					<div class="field">
						<label class="field-label" for="spend-input">Spend per run (USD)</label>
						<input
							id="spend-input"
							type="number"
							min="0"
							step="0.5"
							class="input"
							bind:value={maxBudgetUsd}
						/>
						<span class="field-desc">Estimated from token usage</span>
					</div>
				</div>
			</section>

			<div class="divider"></div>

			<section class="section">
				<div class="section-title">Appearance & defaults</div>
				<div class="section-fields">
					<div class="section-fields-grid">
						<Select id="theme-select" label="Theme" options={THEME_OPTIONS} bind:value={theme} />
						<Select
							id="view-select"
							label="Default view"
							options={VIEW_OPTIONS}
							value={defaultView}
							onchange={(event) => {
								const target = event.currentTarget;
								if (target instanceof HTMLSelectElement) {
									handleDefaultViewChange(target.value);
								}
							}}
						/>
					</div>
				</div>
			</section>

			<div class="divider"></div>

			<section class="section">
				<div class="section-title">Local data</div>
				<div class="section-desc">
					Everything Stardust stores lives under <span class="mono">~/.stardust/</span>. Nothing is
					sent anywhere but the model provider.
				</div>
				<div class="paths">
					<div class="path-row">
						<span class="path-label">Database</span>
						<span class="path-value">~/.stardust/stardust.db</span>
					</div>
					<div class="path-row">
						<span class="path-label">Artifacts</span>
						<span class="path-value">~/.stardust/artifacts</span>
					</div>
					<div class="path-row">
						<span class="path-label">Workspaces</span>
						<span class="path-value">~/.stardust/ws</span>
					</div>
				</div>
				<div class="danger-zone">
					<svg
						width="17"
						height="17"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						style="color:var(--cinder-color-danger-fg);flex:none"
					>
						<path d="M3 6h18" />
						<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
						<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
						<line x1="10" x2="10" y1="11" y2="17" />
						<line x1="14" x2="14" y1="11" y2="17" />
					</svg>
					<div class="danger-info">
						<div class="danger-title">Reset all local state</div>
						<div class="danger-desc">
							Deletes the database, artifacts, workspaces, and model cache. Sessions, transcripts,
							memory, and schedules are gone. This cannot be undone.
						</div>
					</div>
					<Button variant="soft-danger" size="sm" label="Reset…" onclick={clearLocalData} />
				</div>
			</section>
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.page-body {
		flex: 1;
		overflow: auto;
		padding: 24px;
	}

	.settings-column {
		max-width: 680px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 26px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.section-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
		margin-bottom: -10px;
	}

	.section-desc {
		font: 400 12px system-ui;
		color: var(--cinder-text-subtle);
	}

	.section-fields {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.section-fields-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.divider {
		height: 1px;
		background: var(--cinder-border);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		font: 500 12.5px system-ui;
		color: var(--cinder-text);
	}

	.input {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-md, 8px);
		background: var(--cinder-surface-inset);
		color: var(--cinder-text);
		font: 500 13px system-ui;
	}

	.input:focus {
		outline: 2px solid var(--cinder-accent);
		outline-offset: 2px;
	}

	.field-desc {
		font: 400 11px system-ui;
		color: var(--cinder-text-subtle);
	}

	.toggle-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		padding: 13px 15px;
		background: var(--cinder-surface);
	}

	.toggle-info {
		flex: 1;
	}

	.toggle-label {
		font: 600 12.5px system-ui;
		color: var(--cinder-text);
	}

	.toggle-desc {
		font: 400 11.5px system-ui;
		color: var(--cinder-text-subtle);
		margin-top: 2px;
	}

	.mono {
		font-family: var(--cinder-font-mono);
	}

	.paths {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.path-row {
		display: flex;
		justify-content: space-between;
		border: 1px solid var(--cinder-border-muted);
		border-radius: 8px;
		padding: 10px 12px;
		font: 500 12px var(--cinder-font-mono);
	}

	.path-label {
		color: var(--cinder-text-subtle);
	}

	.path-value {
		color: var(--cinder-text);
	}

	.danger-zone {
		display: flex;
		align-items: center;
		gap: 10px;
		border: 1px solid var(--cinder-color-danger-border);
		background: var(--cinder-color-danger-bg);
		border-radius: 10px;
		padding: 13px 15px;
	}

	.danger-info {
		flex: 1;
	}

	.danger-title {
		font: 600 12.5px system-ui;
		color: var(--cinder-color-danger-fg);
	}

	.danger-desc {
		font: 400 11px system-ui;
		color: var(--cinder-color-danger-fg);
		opacity: 0.9;
	}
</style>
