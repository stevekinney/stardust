ALTER TABLE `sessions` ADD `transcript_cursor` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `transcript_events` ADD `session_sequence` integer;
--> statement-breakpoint
WITH ordered_transcript_events AS (
	SELECT
		`id`,
		ROW_NUMBER() OVER (
			PARTITION BY `session_id`
			ORDER BY `created_at`, `run_id`, `sequence`, `id`
		) AS `next_session_sequence`
	FROM `transcript_events`
)
UPDATE `transcript_events`
SET `session_sequence` = (
	SELECT `next_session_sequence`
	FROM `ordered_transcript_events`
	WHERE `ordered_transcript_events`.`id` = `transcript_events`.`id`
)
WHERE `session_sequence` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_events_session_id_session_sequence_unique`
ON `transcript_events` (`session_id`, `session_sequence`);
--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`temporal_run_id` text,
	`workflow_type` text NOT NULL,
	`task_queue` text NOT NULL,
	`parent_workflow_id` text,
	`parent_temporal_run_id` text,
	`session_id` text,
	`run_id` text,
	`continued_from_execution_id` text,
	`continued_to_execution_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text,
	`closed_at` text,
	`history_length` integer,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_workflow_id_temporal_run_id_unique`
ON `workflow_executions` (`workflow_id`, `temporal_run_id`);
--> statement-breakpoint
CREATE INDEX `workflow_executions_run_id_idx`
ON `workflow_executions` (`run_id`);
--> statement-breakpoint
CREATE INDEX `workflow_executions_session_id_idx`
ON `workflow_executions` (`session_id`);
--> statement-breakpoint
CREATE TABLE `schedule_fire_events` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`trigger_source` text DEFAULT 'scheduled' NOT NULL,
	`scheduled_time` text,
	`actual_trigger_time` text NOT NULL,
	`overlap_policy` text NOT NULL,
	`scheduled_workflow_id` text,
	`scheduled_temporal_run_id` text,
	`target_session_key` text NOT NULL,
	`accepted_run_id` text,
	`status` text DEFAULT 'started' NOT NULL,
	`error` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedule_fire_events_schedule_id_idx`
ON `schedule_fire_events` (`schedule_id`);
--> statement-breakpoint
CREATE INDEX `schedule_fire_events_accepted_run_id_idx`
ON `schedule_fire_events` (`accepted_run_id`);
