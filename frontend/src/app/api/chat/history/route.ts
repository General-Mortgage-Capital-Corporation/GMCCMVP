import { type NextRequest, NextResponse } from "next/server";
import {
  getChatMessages,
  setChatMessages,
  clearChatMessages,
  getChatIndex,
} from "@/lib/redis-cache";
import { verifyIdToken } from "@/lib/firestore-admin";

export const runtime = "nodejs";

/** Verify Firebase token and return user email, or null + response. */
async function authenticateRequest(
  req: NextRequest,
): Promise<{ userId: string } | { response: NextResponse }> {
  const userId = req.headers.get("X-User-Email");
  const idToken = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!userId) return { response: NextResponse.json({ messages: [], conversations: [] }) };
  if (idToken) {
    const uid = await verifyIdToken(idToken);
    if (!uid) return { response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
  return { userId };
}

/** GET — load a conversation or list all conversations */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;

  const convId = req.nextUrl.searchParams.get("id");

  // If conversation ID provided, load that conversation
  if (convId) {
    console.log(`[chat-history] GET messages for conv=${convId} user=${userId}`);
    const messages = await getChatMessages(userId, convId);
    console.log(`[chat-history] Result: ${messages ? messages.length + " messages" : "null"}`);
    return NextResponse.json({ messages: messages ?? [] });
  }

  // Otherwise list all conversations
  console.log(`[chat-history] GET index for user=${userId}`);
  const conversations = await getChatIndex(userId);
  return NextResponse.json({ conversations });
}

/** POST — save a conversation */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || !body.conversationId) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const error = await setChatMessages(userId, body.conversationId, body.messages, body.title ?? "Untitled");
  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** DELETE — delete a conversation */
export async function DELETE(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;

  const convId = req.nextUrl.searchParams.get("id");
  if (!convId) return NextResponse.json({ ok: true });

  await clearChatMessages(userId, convId);
  return NextResponse.json({ ok: true });
}
