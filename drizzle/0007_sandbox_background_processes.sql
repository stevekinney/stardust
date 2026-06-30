ALTER TABLE `sandbox_commands` ADD `pid` integer;--> statement-breakpoint
ALTER TABLE `sandbox_commands` ADD `process_group_id` integer;--> statement-breakpoint
ALTER TABLE `sandbox_commands` ADD `background` integer DEFAULT false NOT NULL;
