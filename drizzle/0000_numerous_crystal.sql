CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text,
	`object_key` text NOT NULL,
	`storage_provider` text DEFAULT 'local' NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_object_key_unique` ON `artifacts` (`object_key`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`tool_call_id` text,
	`args_hash` text,
	`edited_args` text,
	`policy_version` text,
	`actor` text DEFAULT 'system' NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idempotency_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_ref` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_ledger_idempotency_key_unique` ON `idempotency_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`embedding_model` text,
	`tags` text,
	`run_id` text,
	`confirmed_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`input` text,
	`final_answer` text,
	`usage` text,
	`budget` text,
	`error` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text,
	`command` text NOT NULL,
	`args` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`exit_code` integer,
	`stdout_ref` text,
	`stderr_ref` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`tool_call_id` text,
	`external_snapshot_id` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 'local-subprocess' NOT NULL,
	`workspace_path` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`git_initialized` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_name_unique` ON `sandboxes` (`name`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`temporal_schedule_id` text NOT NULL,
	`target_session_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron_expression` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_temporal_schedule_id_unique` ON `schedules` (`temporal_schedule_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`workflow_id` text NOT NULL,
	`summary_cursor` integer DEFAULT 0,
	`memory_refs` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_session_key_unique` ON `sessions` (`session_key`);--> statement-breakpoint
CREATE TABLE `stream_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`args` text NOT NULL,
	`args_hash` text NOT NULL,
	`idempotency_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_ref` text,
	`result_inline` text,
	`risk` text DEFAULT 'low' NOT NULL,
	`task_queue` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_invocations_tool_call_id_unique` ON `tool_invocations` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `transcript_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
