import { type NextRequest, NextResponse } from "next/server";
import {
  getChatMessages,
  setChatMessages,
  clearChatMessages,
  getChatIndex,
  removeStaleIndexEntry,
} from "@/lib/redis-cache";

export const runtime = "nodejs";

/** GET — load a conversation or list all conversations */
export async function GET(req: NextRequest) {
  const userId = req.headers.get("X-User-Email");
  if (!userId) return NextResponse.json({ messages: [], conversations: [] });

  const convId = req.nextUrl.searchParams.get("id");

  // If conversation ID provided, load that conversation
  if (convId) {
    const messages = await getChatMessages(userId, convId);
    if (!messages || messages.length === 0) {
      // Messages expired or missing — remove stale index entry
      await removeStaleIndexEntry(userId, convId);
      return NextResponse.json({ messages: [], expired: true });
    }
    return NextResponse.json({ messages });
  }

  // Otherwise list all conversations
  const conversations = await getChatIndex(userId);
  return NextResponse.json({ conversations });
}

/** POST — save a conversation */
export async function POST(req: NextRequest) {
  const userId = req.headers.get("X-User-Email");
  if (!userId) {
    return NextResponse.json({ ok: false, error: "No user" }, { status: 400 });
  }

  const { messages, conversationId, title } = await req.json();
  if (!Array.isArray(messages) || !conversationId) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  await setChatMessages(userId, conversationId, messages, title ?? "Untitled");
  return NextResponse.json({ ok: true });
}

/** DELETE — delete a conversation */
export async function DELETE(req: NextRequest) {
  const userId = req.headers.get("X-User-Email");
  if (!userId) return NextResponse.json({ ok: true });

  const convId = req.nextUrl.searchParams.get("id");
  if (!convId) return NextResponse.json({ ok: true });

  await clearChatMessages(userId, convId);
  return NextResponse.json({ ok: true });
}
