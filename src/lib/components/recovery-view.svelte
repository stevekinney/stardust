<script lang="ts">
	import Button from '@lostgradient/cinder/button';
	import { viewMode } from '$lib/view-mode.svelte';
</script>

<div class="recovery-view">
	<!-- Recovery banner -->
	<div class="banner-section">
		<div class="recovery-card">
			<!-- lucide life-buoy -->
			<svg
				class="banner-icon"
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<path d="m4.93 4.93 4.24 4.24" />
				<path d="m14.83 9.17 4.24-4.24" />
				<path d="m14.83 14.83 4.24 4.24" />
				<path d="m9.17 14.83-4.24 4.24" />
				<circle cx="12" cy="12" r="4" />
			</svg>
			<div class="banner-body">
				<div class="banner-heading">Recovered — no state lost</div>
				<div class="banner-description">
					A worker process running this migration was killed mid-activity. Temporal re-dispatched
					the in-flight work to a second worker, which resumed from durable history. No transcript
					events were dropped and nothing ran twice.
				</div>
				{#if viewMode.isEngineer}
					<div class="banner-chips">
						<span class="banner-chip">resumed from event #243</span>
						<span class="banner-chip">same run wf_b0d4</span>
						<span class="banner-chip">no replay gap</span>
						<span class="banner-chip">operator saw a 6s pause</span>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Durability ribbon — recovery variant, rendered inline -->
	<div class="ribbon" role="status" aria-label="Recovery durability status">
		<div class="rib">
			<span class="rib-n">0</span>
			<span class="rib-l">events lost</span>
		</div>
		<div class="rib">
			<span class="rib-n">0</span>
			<span class="rib-l">duplicate executions</span>
		</div>
		<div class="rib">
			<span class="rib-n rib-warning">1</span>
			<span class="rib-l">worker crash survived</span>
		</div>
		<div class="rib">
			<span class="rib-n rib-accent">#243</span>
			<span class="rib-l">resumed from event</span>
		</div>
		<div class="rib">
			<span class="rib-n">6s</span>
			<span class="rib-l">operator-visible pause</span>
		</div>
	</div>

	<!-- Two-column body -->
	<div class="body-columns">
		<!-- LEFT: Recovery timeline -->
		<div class="timeline-pane">
			<div class="section-label">Recovery timeline</div>
			<div class="timeline">
				<div class="timeline-line"></div>

				<!-- Step 1: Generate SQL patch -->
				<div class="timeline-item">
					<span class="tl-dot tl-dot-success"></span>
					<div>
						<div class="tl-title">Generate SQL patch · approved by you</div>
						<div class="tl-meta">worker-1 · 14:02:04</div>
					</div>
				</div>

				<!-- Step 2: Run migration started -->
				<div class="timeline-item">
					<span class="tl-dot tl-dot-info"></span>
					<div>
						<div class="tl-title">Run migration started</div>
						<div class="tl-meta">worker-1 · 14:02:06 · activity runMigration</div>
					</div>
				</div>

				<!-- Step 3: Worker killed -->
				<div class="timeline-item">
					<span class="tl-dot tl-dot-danger tl-dot-icon">
						<!-- lucide x -->
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="none"
							stroke="#fff"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</span>
					<div>
						<div class="tl-title tl-title-danger">worker-1 process killed mid-activity</div>
						<div class="tl-meta">14:02:09 · SIGKILL · heartbeat stopped</div>
					</div>
				</div>

				<!-- Step 4: Temporal re-dispatch callout -->
				<div class="timeline-item timeline-item-callout">
					<span class="tl-dot tl-dot-accent tl-dot-icon tl-dot-lg">
						<!-- lucide life-buoy (small) -->
						<svg
							width="11"
							height="11"
							viewBox="0 0 24 24"
							fill="none"
							stroke="var(--cinder-accent-contrast)"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="10" />
							<path d="m4.93 4.93 4.24 4.24" />
							<path d="m14.83 9.17 4.24-4.24" />
							<path d="m14.83 14.83 4.24 4.24" />
							<path d="m9.17 14.83-4.24 4.24" />
							<circle cx="12" cy="12" r="4" />
						</svg>
					</span>
					<div class="callout-card">
						<div class="callout-title">Temporal re-dispatched the in-flight activity</div>
						<div class="callout-body">
							After the heartbeat timeout, the orchestrator handed the same activity to a healthy
							worker. State came from durable history — not from the dead worker's memory.
						</div>
						<div class="callout-tag">resumed at event #243 · no replay gap</div>
					</div>
				</div>

				<!-- Step 5: Run migration resumed -->
				<div class="timeline-item">
					<span class="tl-dot tl-dot-info"></span>
					<div>
						<div class="tl-title">Run migration resumed</div>
						<div class="tl-meta">worker-2 · 14:02:11</div>
					</div>
				</div>

				<!-- Step 6: Run completed -->
				<div class="timeline-item timeline-item-last">
					<span class="tl-dot tl-dot-success"></span>
					<div>
						<div class="tl-title">Run migration completed · verified row counts</div>
						<div class="tl-meta">worker-2 · 14:02:25 · exit 0</div>
					</div>
				</div>
			</div>
		</div>

		<!-- RIGHT: Sidebar -->
		<div class="sidebar-pane">
			<!-- Workers -->
			<div>
				<div class="section-label">Workers</div>
				<div class="workers-list">
					<!-- worker-1: danger / exited -->
					<div class="worker-card worker-danger">
						<div class="worker-row">
							<span class="worker-dot dot-danger"></span>
							<span class="worker-name name-danger">worker-1</span>
							<span class="spacer"></span>
							<span class="worker-badge badge-danger">exited</span>
						</div>
						<div class="worker-detail detail-danger">pid 48213 · SIGKILL 14:02:09</div>
					</div>
					<!-- worker-2: success / took over -->
					<div class="worker-card worker-success">
						<div class="worker-row">
							<span class="worker-dot dot-success"></span>
							<span class="worker-name name-success">worker-2</span>
							<span class="spacer"></span>
							<span class="worker-badge badge-success">took over</span>
						</div>
						<div class="worker-detail detail-success">pid 48217 · running · 2 activities</div>
					</div>
				</div>
			</div>

			<!-- Prove it yourself -->
			<div class="prove-card">
				<div class="prove-header">
					<!-- lucide flask-conical -->
					<svg
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--cinder-accent-text)"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path
							d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"
						/>
						<path d="M8.5 2h7" />
						<path d="M7 16h10" />
					</svg>
					<span class="prove-title">Prove it yourself</span>
				</div>
				<div class="prove-code">$ bun run chaos</div>
				<p class="prove-description">
					Starts two workers, drives a run to an approval gate, kills one worker mid-run, and
					verifies the run completes on the survivor.
				</p>
				<div class="prove-action">
					<Button variant="secondary" size="sm" fullWidth>
						<span class="btn-content">
							<!-- lucide external-link -->
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
								<polyline points="15 3 21 3 21 9" />
								<line x1="10" y1="14" x2="21" y2="3" />
							</svg>
							Open this run in Temporal Web
						</span>
					</Button>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.recovery-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow: hidden;
	}

	/* ── Banner ── */

	.banner-section {
		flex: none;
		padding: 18px 22px;
		border-bottom: 1px solid var(--cinder-border);
	}

	.recovery-card {
		display: flex;
		gap: 14px;
		align-items: flex-start;
		border: 1px solid var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
		border-radius: 12px;
		padding: 15px 17px;
	}

	.banner-icon {
		color: var(--cinder-color-success-fg);
		flex: none;
		margin-top: 1px;
	}

	.banner-body {
		flex: 1;
	}

	.banner-heading {
		font: 650 16px system-ui;
		color: var(--cinder-color-success-fg);
	}

	.banner-description {
		font: 400 13px / 1.55 system-ui;
		color: var(--cinder-color-success-fg);
		opacity: 0.92;
		margin-top: 4px;
		max-width: 80ch;
	}

	.banner-chips {
		display: flex;
		gap: 7px;
		flex-wrap: wrap;
		margin-top: 11px;
	}

	.banner-chip {
		font: 500 11px system-ui;
		color: var(--cinder-color-success-fg);
		background: transparent;
		border: 1px solid var(--cinder-color-success-border);
		border-radius: var(--cinder-radius-sm);
		padding: 3px 8px;
	}

	/* ── Durability ribbon (recovery variant) ── */

	.ribbon {
		display: flex;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: linear-gradient(180deg, var(--cinder-surface-inset) 0%, var(--cinder-surface) 100%);
		flex: none;
	}

	.rib {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 10px 8px;
	}

	.rib + .rib {
		border-left: 1px solid var(--cinder-border-muted);
	}

	.rib-n {
		font: 700 17px system-ui;
		color: var(--cinder-text);
		font-family: var(--cinder-font-mono);
	}

	.rib-warning {
		color: var(--cinder-warning);
	}

	.rib-accent {
		color: var(--cinder-accent-text);
	}

	.rib-l {
		font: 400 9.5px system-ui;
		color: var(--cinder-text-subtle);
		text-align: center;
		white-space: nowrap;
	}

	/* ── Two-column body ── */

	.body-columns {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	/* ── Timeline pane (left) ── */

	.timeline-pane {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 22px 24px;
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.section-label {
		font: 600 10px system-ui;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--cinder-text-subtle);
		margin-bottom: 16px;
	}

	.timeline {
		position: relative;
		padding-left: 26px;
	}

	.timeline-line {
		position: absolute;
		left: 6px;
		top: 6px;
		bottom: 6px;
		width: 2px;
		background: var(--cinder-border);
	}

	.timeline-item {
		position: relative;
		margin-bottom: 18px;
	}

	.timeline-item-last {
		margin-bottom: 0;
	}

	/* Default dot (13×13) */
	.tl-dot {
		position: absolute;
		left: -26px;
		top: 1px;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	/* Larger icon-hosting dots */
	.tl-dot-icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Size variant for x-icon dot (15×15, shifted) */
	.tl-dot-icon:not(.tl-dot-lg) {
		left: -27px;
		width: 15px;
		height: 15px;
	}

	/* Size variant for life-buoy callout dot (17×17, shifted) */
	.tl-dot-lg {
		left: -28px;
		width: 17px;
		height: 17px;
	}

	.tl-dot-success {
		background: var(--cinder-success);
	}

	.tl-dot-info {
		background: var(--cinder-info);
	}

	.tl-dot-danger {
		background: var(--cinder-danger);
	}

	.tl-dot-accent {
		background: var(--cinder-accent);
	}

	.tl-title {
		font: 600 13px system-ui;
		color: var(--cinder-text);
	}

	.tl-title-danger {
		color: var(--cinder-danger);
	}

	.tl-meta {
		font: 400 10.5px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		margin-top: 2px;
	}

	/* Callout card (Temporal re-dispatch) */
	.timeline-item-callout {
		margin-bottom: 18px;
	}

	.callout-card {
		border: 1px solid var(--cinder-accent);
		background: var(--cinder-surface-inset);
		border-radius: 10px;
		padding: 12px 14px;
		margin-top: -3px;
	}

	.callout-title {
		font: 600 13px system-ui;
		color: var(--cinder-accent-text);
	}

	.callout-body {
		font: 400 12px / 1.5 system-ui;
		color: var(--cinder-text-subtle);
		margin-top: 4px;
	}

	.callout-tag {
		display: inline-block;
		font: 500 10.5px system-ui;
		font-family: var(--cinder-font-mono);
		color: var(--cinder-text-subtle);
		background: var(--cinder-surface);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
		padding: 3px 8px;
		margin-top: 9px;
	}

	/* ── Sidebar (right) ── */

	.sidebar-pane {
		width: 332px;
		flex: none;
		border-left: 1px solid var(--cinder-border);
		overflow: auto;
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		background: var(--cinder-surface);
		scrollbar-width: thin;
		scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
	}

	.sidebar-pane .section-label {
		letter-spacing: 0.08em;
		margin-bottom: 9px;
	}

	/* Workers */
	.workers-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.worker-card {
		border-radius: 9px;
		padding: 10px 11px;
	}

	.worker-danger {
		border: 1px solid var(--cinder-color-danger-border);
		background: var(--cinder-color-danger-bg);
	}

	.worker-success {
		border: 1px solid var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
	}

	.worker-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.worker-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-danger {
		background: var(--cinder-danger);
	}

	.dot-success {
		background: var(--cinder-success);
	}

	.worker-name {
		font: 600 11.5px system-ui;
	}

	.name-danger {
		color: var(--cinder-color-danger-fg);
	}

	.name-success {
		color: var(--cinder-color-success-fg);
	}

	.spacer {
		flex: 1;
	}

	.worker-badge {
		font:
			600 10px ui-monospace,
			monospace;
	}

	.badge-danger {
		color: var(--cinder-color-danger-fg);
	}

	.badge-success {
		color: var(--cinder-color-success-fg);
	}

	.worker-detail {
		font:
			400 10px ui-monospace,
			monospace;
		opacity: 0.85;
		margin-top: 4px;
	}

	.detail-danger {
		color: var(--cinder-color-danger-fg);
	}

	.detail-success {
		color: var(--cinder-color-success-fg);
	}

	/* Prove it yourself card */
	.prove-card {
		border: 1px solid var(--cinder-border);
		border-radius: 10px;
		background: var(--cinder-surface-raised);
		padding: 13px;
	}

	.prove-header {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.prove-title {
		font: 600 12px system-ui;
		color: var(--cinder-text);
	}

	.prove-code {
		font:
			600 11.5px ui-monospace,
			monospace;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: 7px;
		padding: 8px 10px;
		margin-top: 9px;
		color: var(--cinder-accent-text);
	}

	.prove-description {
		font: 400 11px / 1.5 system-ui;
		color: var(--cinder-text-subtle);
		margin: 8px 0 0;
	}

	.prove-action {
		margin-top: 11px;
	}

	.btn-content {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}
</style>
