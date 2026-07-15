CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `activity_ts_idx` ON `activity_log` (`ts`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`sdk_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`stages` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `item_images` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`role` text NOT NULL,
	`path` text NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_images_item_idx` ON `item_images` (`item_id`);--> statement-breakpoint
CREATE TABLE `item_links` (
	`id` text PRIMARY KEY NOT NULL,
	`item_a_id` text NOT NULL,
	`item_b_id` text NOT NULL,
	`relation` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_a_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_b_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `item_tags` (
	`item_id` text NOT NULL,
	`tag` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`item_id`, `tag`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`category` text,
	`subcategory` text,
	`description` text,
	`notes` text,
	`primary_color` text,
	`secondary_colors` text,
	`color_detail` text,
	`pattern` text,
	`fit` text,
	`material` text,
	`brand` text,
	`size` text,
	`formality` text,
	`seasons` text,
	`price` real,
	`purchase_date` text,
	`wear_count` integer DEFAULT 0 NOT NULL,
	`last_worn_at` text,
	`field_sources` text DEFAULT '{}' NOT NULL,
	`ai_raw` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `items_state_idx` ON `items` (`state`);--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);--> statement-breakpoint
CREATE TABLE `outfit_items` (
	`outfit_id` text NOT NULL,
	`item_id` text NOT NULL,
	`slot` text NOT NULL,
	PRIMARY KEY(`outfit_id`, `item_id`),
	FOREIGN KEY (`outfit_id`) REFERENCES `outfits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outfits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`source` text DEFAULT 'user' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_date` text NOT NULL,
	`outfit_id` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`outfit_id`) REFERENCES `outfits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_date_idx` ON `plans` (`plan_date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trip_items` (
	`trip_id` text NOT NULL,
	`item_id` text NOT NULL,
	`packed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`trip_id`, `item_id`),
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`destination` text,
	`start_date` text,
	`end_date` text,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wear_event_items` (
	`wear_event_id` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`wear_event_id`, `item_id`),
	FOREIGN KEY (`wear_event_id`) REFERENCES `wear_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wear_events` (
	`id` text PRIMARY KEY NOT NULL,
	`worn_on` text NOT NULL,
	`outfit_id` text,
	`occasion` text,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`outfit_id`) REFERENCES `outfits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `wear_events_date_idx` ON `wear_events` (`worn_on`);