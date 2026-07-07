import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * The Temporal SDK's Rust core gives the ephemeral test server a hard-coded
 * five-second connect deadline. Under full-suite startup contention (the
 * browser project booting Chromium while other projects webpack-bundle
 * workflow code) the server can come up just after that deadline, failing
 * whichever suite hit the CPU peak even though nothing is wrong with the
 * code under test. This message is the SDK's documented signature for that
 * startup failure — nothing else is retried.
 */
const EPHEMERAL_SERVER_CONNECT_FAILURE = /Failed connecting to test server/i;

const MAX_ATTEMPTS = 3;

/**
 * Create a time-skipping {@link TestWorkflowEnvironment}, retrying only the
 * ephemeral server's startup connect timeout (capped at three attempts, with
 * a short backoff so the load spike that starved the boot can pass). Any
 * other failure — including anything from the code under test — propagates
 * immediately.
 *
 * A timed-out boot can leak a `temporal-test-server` process that finished
 * starting after the SDK gave up. It is not killed here: the process pattern
 * is shared with sibling suites' live environments, so pattern-killing from
 * a retry path could destroy another file's in-use server. The leak is
 * bounded (one idle process per retried boot) and disappears with the test
 * run's session.
 */
export async function createTimeSkippingEnvironment(
	create: () => Promise<TestWorkflowEnvironment> = () =>
		TestWorkflowEnvironment.createTimeSkipping()
): Promise<TestWorkflowEnvironment> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await create();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!EPHEMERAL_SERVER_CONNECT_FAILURE.test(message)) throw error;
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
		}
	}
	throw lastError;
}
