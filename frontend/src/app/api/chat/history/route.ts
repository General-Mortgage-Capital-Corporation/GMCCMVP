import { type NextRequest, NextResponse } from "next/server";
import {
  getChatMessages,
  setChatMessages,
  clearChatMessages,
  getChatIndex,
} from "@/lib/redis-cache";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";

export const runtime = "nodejs";

/**
 * Verify Firebase token and return the authenticated user's email.
 *
 * Auth contract:
 * - Authorization: Bearer <Firebase ID token> is REQUIRED.
 * - X-User-Email is used as the storage key, but it MUST match the email
 *   embedded in the verified token. This prevents an attacker with a
 *   valid token for their own account from spoofing another user's email
 *   to read/write/delete that user's chat history.
 */
async function authenticateRequest(
  req: NextRequest,
): Promise<{ userId: string } | { response: NextResponse }> {
  const headerEmail = req.headers.get("X-User-Email")?.toLowerCase() ?? "";
  const idToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";

  if (!idToken || !headerEmail) {
    return {
      response: NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      ),
    };
  }

  const verified = await verifyIdTokenWithEmail(idToken);
  if (!verified) {
    return {
      response: NextResponse.json({ error: "Invalid token" }, { status: 401 }),
    };
  }

  if (verified.email !== headerEmail) {
    return {
      response: NextResponse.json(
        { error: "Token/email mismatch" },
        { status: 403 },
      ),
    };
  }

  return { userId: verified.email };
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
