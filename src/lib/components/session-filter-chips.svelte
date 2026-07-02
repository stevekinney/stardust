<script lang="ts" module>
	export type SessionFilter = 'all' | 'running' | 'needs-you' | 'complete';
</script>

<script lang="ts">
	import Chip from '@lostgradient/cinder/chip';

	type Props = {
		value: SessionFilter;
		counts: Record<SessionFilter, number>;
		onchange: (value: SessionFilter) => void;
	};

	let { value, counts, onchange }: Props = $props();

	const filters: Array<{ key: SessionFilter; label: string }> = [
		{ key: 'all', label: 'All' },
		{ key: 'running', label: 'Running' },
		{ key: 'needs-you', label: 'Needs you' },
		{ key: 'complete', label: 'Complete' }
	];
</script>

<div class="chips" role="group" aria-label="Filter sessions">
	{#each filters as filter (filter.key)}
		<Chip
			mode="toggle"
			label="{filter.label} {counts[filter.key]}"
			variant={value === filter.key ? 'accent' : 'neutral'}
			size="sm"
			pressed={value === filter.key}
			onpressedchange={() => onchange(filter.key)}
		/>
	{/each}
</div>

<style>
	.chips {
		display: flex;
		gap: 6px;
	}
</style>
