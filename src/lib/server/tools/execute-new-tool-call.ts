import { z } from 'zod';
import { sendSessionMessage } from '../temporal/session-messaging';
import { timerWaitInput, timerWaitStubContent, sessionSendMessageInput } from './timer-tool';
import { executeScheduleCreate, executeScheduleList, scheduleCreateInput } from './schedule-tools';
import {
	sendUserNotification,
	sendIMessage,
	notifyUserInput,
	imessageSendInput
} from './local-notifications';
import { callPlaywrightMcpTool, isPlaywrightMcpToolAllowed } from './playwright-mcp';
import { lookupLibraryDocs } from './context7';
import { queryScratchDatabase } from './scratch-db';
import {
	feedReadInput,
	hackerNewsReadInput,
	weatherLookupInput,
	wikipediaLookupInput,
	readFeed,
	readHackerNews,
	lookupWeather,
	lookupWikipedia
} from './public-data';
import { requireSessionRun, type ExecuteToolCallInput } from './tool-execution-context';

/**
 * Re-derived `browser.mcp.call` input schema for parsing at execution time.
 * The canonical schema lives inside `playwright-mcp.ts`'s own `define`
 * function and is not exported — mirrors how `temporal.mcp.call`'s schema is
 * built in `tool-definitions.ts` from the module's exported allowlist
 * predicate.
 */
const browserMcpCallInput = z.object({
	toolName: z.string().min(1).refine(isPlaywrightMcpToolAllowed, {
		message: 'Playwright MCP tool is not exposed by Stardust policy'
	}),
	arguments: z.record(z.string(), z.unknown()).default({})
});

/**
 * Re-derived `docs.lookup` input schema for parsing at execution time. The
 * canonical schema lives inside `context7.ts`'s own `define` function and is
 * not exported.
 */
const docsLookupInput = z.object({
	library: z.string().min(1),
	topic: z.string().min(1).optional()
});

/**
 * Re-derived `db.query` input schema for parsing at execution time. The
 * canonical schema lives inside `scratch-db.ts`'s own `define` function and
 * is not exported.
 */
const dbQueryInput = z.object({
	sql: z.string().min(1),
	params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([])
});

/**
 * Executes the tool calls contributed by the keyless "new tool" modules:
 * timers, cross-session messaging, schedules, public-data reads, local
 * macOS notifications, Playwright MCP, Context7, and the scratch database.
 * Split out of `execute-tool-call.ts` to keep both files under the project's
 * 500-line implementation file limit.
 */
export async function executeNewToolCall(input: ExecuteToolCallInput): Promise<unknown> {
	switch (input.call.name) {
		case 'timer.wait':
			// timer.wait is intercepted and executed by the orchestrator workflow
			// itself (like delegate.parallel) — a call only reaches here if that
			// interception did not happen, so this stub content documents why.
			return timerWaitStubContent(timerWaitInput.parse(input.call.arguments));
		case 'session.sendMessage': {
			const { sessionKey } = requireSessionRun(input);
			const args = sessionSendMessageInput.parse(input.call.arguments);
			return sendSessionMessage({
				targetSessionKey: args.sessionKey,
				message: args.message,
				fromSessionKey: sessionKey
			});
		}
		case 'schedule.create': {
			const args = scheduleCreateInput.parse(input.call.arguments);
			return executeScheduleCreate(args);
		}
		case 'schedule.list':
			return executeScheduleList();
		case 'notify.user': {
			const args = notifyUserInput.parse(input.call.arguments);
			return sendUserNotification(args);
		}
		case 'imessage.send': {
			const args = imessageSendInput.parse(input.call.arguments);
			return sendIMessage(args);
		}
		case 'browser.mcp.call': {
			const args = browserMcpCallInput.parse(input.call.arguments);
			return callPlaywrightMcpTool({ toolName: args.toolName, arguments: args.arguments });
		}
		case 'docs.lookup': {
			const args = docsLookupInput.parse(input.call.arguments);
			return lookupLibraryDocs({ library: args.library, topic: args.topic });
		}
		case 'db.query': {
			const { sessionKey } = requireSessionRun(input);
			const args = dbQueryInput.parse(input.call.arguments);
			return queryScratchDatabase({ sessionKey, sql: args.sql, params: args.params });
		}
		case 'feed.read': {
			const args = feedReadInput.parse(input.call.arguments);
			return readFeed(args, { fetcher: input.fetcher });
		}
		case 'hackernews.read': {
			const args = hackerNewsReadInput.parse(input.call.arguments);
			return readHackerNews(args, { fetcher: input.fetcher });
		}
		case 'weather.lookup': {
			const args = weatherLookupInput.parse(input.call.arguments);
			return lookupWeather(args, { fetcher: input.fetcher });
		}
		case 'wikipedia.lookup': {
			const args = wikipediaLookupInput.parse(input.call.arguments);
			return lookupWikipedia(args, { fetcher: input.fetcher });
		}
		default:
			throw new Error(`Unknown tool: ${input.call.name}`);
	}
}
