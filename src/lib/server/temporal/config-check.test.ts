import { describe, expect, it } from 'vitest';
import {
	assertTemporalConfig,
	describeTemporalConfigProblem,
	isCloudTemporalAddress,
	isLocalTemporalAddress,
	normalizeTemporalConfigForAddress
} from './config-check';

describe('isLocalTemporalAddress', () => {
	it('recognizes loopback hosts', () => {
		expect(isLocalTemporalAddress('localhost:7233')).toBe(true);
		expect(isLocalTemporalAddress('127.0.0.1:7233')).toBe(true);
		expect(isLocalTemporalAddress('[::1]:7233')).toBe(true);
	});

	it('rejects remote hosts', () => {
		expect(isLocalTemporalAddress('ap-northeast-1.aws.api.temporal.io:7233')).toBe(false);
		expect(isLocalTemporalAddress('10.0.0.5:7233')).toBe(false);
	});
});

describe('isCloudTemporalAddress', () => {
	it('recognizes managed Cloud endpoints', () => {
		expect(isCloudTemporalAddress('ap-northeast-1.aws.api.temporal.io:7233')).toBe(true);
		expect(isCloudTemporalAddress('foo.tmprl.cloud:7233')).toBe(true);
	});

	it('rejects local and arbitrary hosts', () => {
		expect(isCloudTemporalAddress('localhost:7233')).toBe(false);
		expect(isCloudTemporalAddress('10.0.0.5:7233')).toBe(false);
	});
});

describe('describeTemporalConfigProblem', () => {
	it('accepts a coherent local configuration', () => {
		expect(
			describeTemporalConfigProblem({ address: 'localhost:7233', namespace: 'default' })
		).toBeNull();
	});

	it('accepts a coherent Cloud configuration', () => {
		expect(
			describeTemporalConfigProblem({
				address: 'ap-northeast-1.aws.api.temporal.io:7233',
				namespace: 'depict.bnfgy',
				apiKey: 'a-key'
			})
		).toBeNull();
	});

	it('flags a local address with a Cloud-looking namespace (the leak)', () => {
		const problem = describeTemporalConfigProblem({
			address: 'localhost:7233',
			namespace: 'depict.bnfgy'
		});
		expect(problem).not.toBeNull();
		expect(problem?.summary).toContain('depict.bnfgy');
		expect(problem?.summary).toContain('localhost:7233');
		expect(problem?.detail).toContain('unset TEMPORAL_NAMESPACE TEMPORAL_API_KEY');
	});

	it('flags a local address with a Cloud API key even when the namespace is bare', () => {
		const problem = describeTemporalConfigProblem({
			address: '127.0.0.1:7233',
			namespace: 'default',
			apiKey: 'leaked-key'
		});
		expect(problem).not.toBeNull();
		expect(problem?.summary).toContain('TEMPORAL_API_KEY=<set>');
	});

	it('flags a Cloud address with no API key', () => {
		const problem = describeTemporalConfigProblem({
			address: 'foo.tmprl.cloud:7233',
			namespace: 'depict.bnfgy'
		});
		expect(problem).not.toBeNull();
		expect(problem?.summary).toContain('authentication will fail');
	});

	it('ignores an empty-string API key', () => {
		expect(
			describeTemporalConfigProblem({ address: 'localhost:7233', namespace: 'default', apiKey: '' })
		).toBeNull();
	});
});

describe('normalizeTemporalConfigForAddress', () => {
	it('drops leaked Cloud credentials for a local address', () => {
		expect(
			normalizeTemporalConfigForAddress({
				address: 'localhost:7234',
				namespace: 'depict.bnfgy',
				apiKey: 'leaked-key'
			})
		).toEqual({ address: 'localhost:7234', namespace: 'default', apiKey: undefined });
	});

	it('preserves a bare local namespace but still drops the API key', () => {
		expect(
			normalizeTemporalConfigForAddress({
				address: '127.0.0.1:7233',
				namespace: 'staging',
				apiKey: 'leaked-key'
			})
		).toEqual({ address: '127.0.0.1:7233', namespace: 'staging', apiKey: undefined });
	});

	it('leaves a coherent local configuration untouched', () => {
		expect(
			normalizeTemporalConfigForAddress({ address: 'localhost:7233', namespace: 'default' })
		).toEqual({ address: 'localhost:7233', namespace: 'default', apiKey: undefined });
	});

	it('passes remote (Cloud) configuration through unchanged', () => {
		const cloud = {
			address: 'ap-northeast-1.aws.api.temporal.io:7233',
			namespace: 'depict.bnfgy',
			apiKey: 'a-key'
		};
		expect(normalizeTemporalConfigForAddress(cloud)).toEqual(cloud);
	});

	it('always yields a coherent config for a local address', () => {
		// The orchestrator relies on this: after normalizing, the guardrail must pass.
		expect(
			describeTemporalConfigProblem(
				normalizeTemporalConfigForAddress({
					address: 'localhost:7234',
					namespace: 'depict.bnfgy',
					apiKey: 'leaked-key'
				})
			)
		).toBeNull();
	});
});

describe('assertTemporalConfig', () => {
	it('does not throw on a coherent configuration', () => {
		expect(() =>
			assertTemporalConfig({ address: 'localhost:7233', namespace: 'default' })
		).not.toThrow();
	});

	it('throws with summary and detail on an incoherent configuration', () => {
		expect(() =>
			assertTemporalConfig({ address: 'localhost:7233', namespace: 'depict.bnfgy' })
		).toThrow(/depict\.bnfgy[\s\S]*unset TEMPORAL_NAMESPACE/);
	});
});
