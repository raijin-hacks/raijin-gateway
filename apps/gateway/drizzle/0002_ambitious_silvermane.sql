CREATE TABLE `pay_review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`outcome` text NOT NULL,
	`note` text NOT NULL,
	`reasons_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
