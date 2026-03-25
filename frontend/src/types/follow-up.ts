export interface FollowUpRecord {
  id?: string;
  userId: string;
  userEmail: string;
  recipientEmail: string;
  recipientName: string;
  recipientType: "realtor" | "borrower";
  subject: string;
  bodyPreview: string;
  propertyAddress: string;
  programNames: string[];
  sentAt: number; // Unix ms
  /** True if the recipient has replied (tracked for all emails, not just follow-ups) */
  hasReply?: boolean;
  followUp: {
    mode: "remind" | "auto-send";
    scheduledAt: number; // Unix ms
    status: "pending" | "sent" | "dismissed" | "replied";
    reminderCount: number;
    lastReminderAt: number | null;
    draftSubject: string | null;
    draftBody: string | null;
  } | null;
}

export interface FollowUpListItem extends FollowUpRecord {
  id: string;
}
