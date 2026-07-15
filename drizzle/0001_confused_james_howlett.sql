PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`stages` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_import_jobs`("id", "item_id", "stages", "status", "error", "created_at", "updated_at") SELECT "id", "item_id", "stages", "status", "error", "created_at", "updated_at" FROM `import_jobs`;--> statement-breakpoint
DROP TABLE `import_jobs`;--> statement-breakpoint
ALTER TABLE `__new_import_jobs` RENAME TO `import_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;