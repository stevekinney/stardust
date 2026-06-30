ALTER TABLE `stream_events` ADD `deduplication_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `stream_events_run_id_deduplication_key_unique` ON `stream_events` (`run_id`, `deduplication_key`);
