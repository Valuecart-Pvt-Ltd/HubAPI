// ─── Read.ai webhook payload ─────────────────────────────────────────────────

export interface ReadAIParticipant {
  name:  string
  email: string
}

export interface ReadAIActionItem {
  text:      string
  assignee?: string  // display name or email
  dueDate?:  string  // ISO date string
}

export interface ReadAIWebhookPayload {
  meetingId:   string
  meetingTitle: string
  startTime:   string  // ISO datetime
  participants: ReadAIParticipant[]
  summary?:    string
  actionItems: ReadAIActionItem[]
}

// ─── Fireflies.ai webhook payload ────────────────────────────────────────────

export interface FirefliesParticipant {
  displayName: string
  email:       string
}

export interface FirefliesTaskItem {
  text:       string
  assignee?:  string
  due_date?:  string  // ISO date string
}

export interface FirefliesTranscript {
  id:           string
  title:        string
  date:         string  // ISO datetime
  participants: FirefliesParticipant[]
  summary?: {
    action_items?: string  // may be a raw text block instead of structured array
  }
  tasks?:       FirefliesTaskItem[]
}

export interface FirefliesWebhookPayload {
  meetingId:  string
  transcript: FirefliesTranscript
}

// ─── Normalised item (provider-agnostic) ─────────────────────────────────────

export type MomItemStatus = 'pending' | 'in-progress' | 'completed'

export interface NormalizedMomItem {
  action_item:  string
  owner_email:  string | null   // null when assignee couldn't be resolved to an email
  owner_name:   string | null   // raw display name from the transcript
  eta:          string | null   // ISO date string
  category:     string          // inferred from heuristics
  status:       MomItemStatus
}

export interface ParsedMeeting {
  title:       string
  startTime:   string           // ISO datetime
  attendees:   string[]         // emails where available
  items:       NormalizedMomItem[]
}
