CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`proposed_args` text NOT NULL,
	`canonical_args` text,
	`args_hash` text NOT NULL,
	`edited_args` text,
	`reason` text,
	`remember` integer DEFAULT false NOT NULL,
	`policy_version` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
