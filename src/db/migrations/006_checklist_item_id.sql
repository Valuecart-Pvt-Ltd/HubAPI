-- Track the Trello checklist item ID per MOM action item.
-- Replaces the comments-based approach: each action item is now a checklist
-- item on the Trello card so it can be individually checked off.

ALTER TABLE mom_items
  ADD COLUMN IF NOT EXISTS trello_checklist_item_id TEXT;
