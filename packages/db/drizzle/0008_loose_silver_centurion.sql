CREATE INDEX "activity_candidate_idx" ON "activity_events" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "activity_source_idx" ON "activity_events" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "candidate_watchlist_idx" ON "company_candidates" USING btree ("watchlist_id");--> statement-breakpoint
CREATE INDEX "candidate_source_idx" ON "company_candidates" USING btree ("source_id");