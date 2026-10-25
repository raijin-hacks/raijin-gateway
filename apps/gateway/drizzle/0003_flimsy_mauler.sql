CREATE TABLE `agent_incidents` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`mandate_id` text NOT NULL,
	`cause` text NOT NULL,
	`previous` text NOT NULL,
	`restriction` text NOT NULL,
	`restriction_epoch` integer NOT NULL,
	`severe` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_incidents_agent_mandate` ON `agent_incidents` (`agent_id`,`mandate_id`,`restriction_epoch`);--> statement-breakpoint
CREATE TABLE `agent_restorations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`previous` text NOT NULL,
	`restriction` text NOT NULL,
	`reason` text NOT NULL,
	`operator` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `restriction` text DEFAULT 'normal' NOT NULL CONSTRAINT agents_restriction CHECK (restriction IN ('normal','review_required','suspended'));--> statement-breakpoint
ALTER TABLE `agents` ADD `restriction_epoch` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER agent_incidents_no_update BEFORE UPDATE ON agent_incidents BEGIN SELECT RAISE(ABORT, 'agent_incidents is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER agent_incidents_no_delete BEFORE DELETE ON agent_incidents BEGIN SELECT RAISE(ABORT, 'agent_incidents is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER agent_restorations_no_update BEFORE UPDATE ON agent_restorations BEGIN SELECT RAISE(ABORT, 'agent_restorations is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER agent_restorations_no_delete BEFORE DELETE ON agent_restorations BEGIN SELECT RAISE(ABORT, 'agent_restorations is append-only'); END;
