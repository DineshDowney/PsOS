CREATE TABLE `regen_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`sides` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`results` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `regen_jobs_item_idx` ON `regen_jobs` (`item_id`);