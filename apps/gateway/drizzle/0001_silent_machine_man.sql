CREATE TABLE `gateway_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pay_workflows` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`binding` text NOT NULL,
	`state` text NOT NULL,
	`owner` text NOT NULL,
	`catalog_revision` text NOT NULL,
	`request_json` text NOT NULL,
	`quote_json` text,
	`deadline` integer NOT NULL,
	`response_json` text,
	`reviewed_json` text NOT NULL,
	`tier0_at` integer,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pay_workflows_state" CHECK("pay_workflows"."state" IN ('PROCESSING','REVIEW','AUTHORIZED','UNKNOWN','TERMINAL'))
);
