CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role_id` text NOT NULL,
	`name` text NOT NULL,
	`trust` real NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`reviewer` text NOT NULL,
	`outcome` text NOT NULL,
	`note` text NOT NULL,
	`issue_grant` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_outcome" CHECK("approvals"."outcome" IN ('approved','rejected','timeout'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_decision_id_unique` ON `approvals` (`decision_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`mandate_id` text NOT NULL,
	`session_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`method` text NOT NULL,
	`endpoint_id` text,
	`payee` text,
	`price` integer,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`reasons_json` text NOT NULL,
	`explanation` text,
	`judge_ms` integer,
	`created_at` integer NOT NULL,
	`request_json` text,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "decisions_stage" CHECK("decisions"."stage" IN ('precontact','tier0','tier1','judge','human')),
	CONSTRAINT "decisions_outcome" CHECK("decisions"."outcome" IN ('approved','denied','pending'))
);
--> statement-breakpoint
CREATE INDEX `decisions_session_time` ON `decisions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_session_url_price` ON `decisions` (`session_id`,`canonical_url`,`price`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_mandate_stage_outcome` ON `decisions` (`mandate_id`,`stage`,`outcome`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_idempotency` ON `decisions` (`mandate_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`params_json` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "endpoints_method" CHECK("endpoints"."method" IN ('GET','POST'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `endpoints_route` ON `endpoints` (`merchant_id`,`method`,`path`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`mandate_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`payee` text NOT NULL,
	`method` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`option_values_json` text NOT NULL,
	`max_per_call` integer NOT NULL,
	`max_total` integer NOT NULL,
	`used_total` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grants_source" CHECK("grants"."source" IN ('judge','human'))
);
--> statement-breakpoint
CREATE INDEX `grants_mandate_endpoint` ON `grants` (`mandate_id`,`endpoint_id`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task` text NOT NULL,
	`subjects_json` text NOT NULL,
	`allowed_merchants_json` text NOT NULL,
	`budget` integer NOT NULL,
	`spent` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mandates_status" CHECK("mandates"."status" IN ('active','closed','expired')),
	CONSTRAINT "mandates_money" CHECK("mandates"."spent" >= 0 AND "mandates"."reserved" >= 0 AND "mandates"."spent" + "mandates"."reserved" <= "mandates"."budget")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mandates_token_hash_unique` ON `mandates` (`token_hash`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`payee` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`mandate_id` text NOT NULL,
	`amount` integer NOT NULL,
	`payee` text NOT NULL,
	`nonce` text,
	`valid_before` integer,
	`authorization_json` text,
	`state` text NOT NULL,
	`tx_hash` text,
	`updated_at` integer NOT NULL,
	`quote_json` text,
	`response_json` text,
	`day` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_state" CHECK("payments"."state" IN ('RESERVED','SIGNED','SUBMITTED','SETTLED','FAILED','UNKNOWN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_decision_id_unique` ON `payments` (`decision_id`);--> statement-breakpoint
CREATE INDEX `payments_state_idx` ON `payments` (`state`);--> statement-breakpoint
CREATE TABLE `reference_prices` (
	`tenant_id` text NOT NULL,
	`payee` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`price` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `payee`, `endpoint_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`policy_text` text NOT NULL,
	`per_call_cap` integer NOT NULL,
	`velocity_per_min` integer NOT NULL,
	`baseline_trust` integer NOT NULL,
	`grant_trust_threshold` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`mandate_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`trust` real NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_status" CHECK("sessions"."status" IN ('active','quarantined','ended'))
);
--> statement-breakpoint
CREATE TABLE `standing_grant_usage` (
	`standing_grant_id` text NOT NULL,
	`day` text NOT NULL,
	`used_total` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`standing_grant_id`, `day`),
	FOREIGN KEY (`standing_grant_id`) REFERENCES `standing_grants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "standing_grant_usage_used" CHECK("standing_grant_usage"."used_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE `standing_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`max_per_call` integer NOT NULL,
	`daily_total` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tenant_daily` (
	`tenant_id` text NOT NULL,
	`day` text NOT NULL,
	`committed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`tenant_id`, `day`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tenant_daily_committed" CHECK("tenant_daily"."committed" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`daily_cap` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trust_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`delta_session` real NOT NULL,
	`delta_agent` real NOT NULL,
	`cause` text NOT NULL,
	`decision_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
