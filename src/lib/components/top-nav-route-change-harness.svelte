<script lang="ts">
	import TopNav from './top-nav.svelte';

	let currentPath = $state('/');
</script>

<TopNav {currentPath} />

<button type="button" data-testid="route-change" onclick={() => (currentPath = '/settings')}>
	Change route
</button>
