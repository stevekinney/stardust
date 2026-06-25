import type { SessionState, SubmitTurnInput, SubmitTurnResult } from '@src/lib/types';
import { defineQuery, defineUpdate } from '@temporalio/workflow';

/** Update: submit a new user turn; returns accepted=true and a fresh runId. */
export const submitTurnUpdate = defineUpdate<SubmitTurnResult, [SubmitTurnInput]>('submitTurn');

/** Query: current session state snapshot (non-mutating). */
export const getSessionStateQuery = defineQuery<SessionState, []>('getSessionState');
