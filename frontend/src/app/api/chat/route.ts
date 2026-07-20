import {
  ToolLoopAgent,
  stepCountIs,
  createAgentUIStreamResponse,
  type InferAgentUIMessage,
} from "ai";
import { searchPropertiesTool } from "@/lib/tools/search-properties";
import { matchProgramsTool } from "@/lib/tools/match-programs";
import { lookupProgramsTool } from "@/lib/tools/lookup-programs";
import { askForConfirmationTool } from "@/lib/tools/ask-for-confirmation";
import { askUserTool } from "@/lib/tools/ask-user";
import { searchKnowledgeTool } from "@/lib/tools/search-knowledge";
import { createQueryAdmiralTool } from "@/lib/tools/query-admiral";
import { createResearchRealtorTool } from "@/lib/tools/research-realtor";
import { createDraftEmailTool } from "@/lib/tools/draft-email";
import { createGenerateFlyerTool } from "@/lib/tools/generate-flyer";
import { createSendEmailTool } from "@/lib/tools/send-email";
import { createRecordFollowUpTool } from "@/lib/tools/record-follow-up";
import { createWebSearchTool } from "@/lib/tools/web-search";
import { searchByProgramTool } from "@/lib/tools/search-by-program";
import { createGenerateCsvTool } from "@/lib/tools/generate-csv";
import { checkCRAEligibilityTool } from "@/lib/tools/check-cra-eligibility";
import { createSearchSentEmailsTool } from "@/lib/tools/search-sent-emails";
import { fetchPropertyPhotoTool } from "@/lib/tools/fetch-property-photo";
import { lookupPropertyTool } from "@/lib/tools/lookup-property";
import { SYSTEM_PROMPT } from "@/lib/agents/gmcc-agent";
import { requireAuth, unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!(await requireAuth(req))) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: "messages array required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { messages } = body;

  // Guard against abuse: cap conversation size
  if (messages.length > 200) {
    return new Response(JSON.stringify({ error: "Conversation too long" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Extract auth context from headers
  const firebaseToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const msalToken = req.headers.get("X-MSAL-Token") ?? "";
  const userEmail = req.headers.get("X-User-Email") ?? "";

  // Decode email signature (base64 UTF-8 from client)
  const sigHeader = req.headers.get("X-Email-Signature") ?? "";
  let signatureHtml = "";
  if (sigHeader) {
    try {
      const raw = decodeURIComponent(escape(atob(sigHeader)));
      // Strip script tags and event handlers to prevent HTML injection in emails
      signatureHtml = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
    } catch { /* ignore decode errors */ }
  }

  // Decode LO profile info (name, title, NMLS, phone)
  const loHeader = req.headers.get("X-LO-Info") ?? "";
  let loInfo: { name?: string; nmls?: string; phone?: string; email?: string; title?: string } = {};
  if (loHeader) {
    try {
      loInfo = JSON.parse(decodeURIComponent(escape(atob(loHeader))));
    } catch { /* ignore */ }
  }

  // Sanitize LO fields before interpolating into system prompt (prevent prompt injection)
  const sanitizeField = (s?: string) => s?.replace(/[\n\r]/g, " ").slice(0, 100) ?? "";

  // Build user context block for the system prompt
  const userContext = [
    loInfo.name && `Name: ${sanitizeField(loInfo.name)}`,
    loInfo.title && `Title: ${sanitizeField(loInfo.title)}`,
    loInfo.nmls && `NMLS#: ${sanitizeField(loInfo.nmls)}`,
    loInfo.phone && `Phone: ${sanitizeField(loInfo.phone)}`,
    userEmail && `Email: ${userEmail.slice(0, 100)}`,
  ].filter(Boolean).join("\n");

  const personalizedPrompt = userContext
    ? `${SYSTEM_PROMPT}\n\n## Current User (Loan Officer)\n${userContext}\n\nAlways use this information when drafting emails, referencing the loan officer, or personalizing content. Never use placeholders like "[Your Name]" — use the real name above.`
    : SYSTEM_PROMPT;

  const authContext = { firebaseToken, msalToken, userEmail, signatureHtml, loTitle: loInfo.title ?? "" };

  // Construct agent per-request with auth-bound tools
  const agent = new ToolLoopAgent({
    model: "google/gemini-3-flash",
    instructions: personalizedPrompt,
    tools: {
      // Phase 1 tools (no auth needed)
      searchProperties: searchPropertiesTool,
      matchPrograms: matchProgramsTool,
      lookupPrograms: lookupProgramsTool,
      searchKnowledge: searchKnowledgeTool,
      // Human-in-the-loop
      askForConfirmation: askForConfirmationTool,
      askUser: askUserTool,
      // Phase 2 tools (auth-bound)
      queryAdmiral: createQueryAdmiralTool(authContext),
      researchRealtor: createResearchRealtorTool(),
      draftEmail: createDraftEmailTool({ signatureHtml }),
      generateFlyer: createGenerateFlyerTool(authContext),
      sendEmail: createSendEmailTool(authContext),
      recordFollowUp: createRecordFollowUpTool(authContext),
      webSearch: createWebSearchTool(),
      searchByProgram: searchByProgramTool,
      generateCsv: createGenerateCsvTool(),
      checkCRAEligibility: checkCRAEligibilityTool,
      searchSentEmails: createSearchSentEmailsTool(authContext),
      fetchPropertyPhoto: fetchPropertyPhotoTool,
      lookupProperty: lookupPropertyTool,
    },
    stopWhen: stepCountIs(25),
    temperature: 0.3,
  });

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    // Capture agent/tool/model failures. Before this there was NO server-side
    // error record — failures vanished into the stream and the client only
    // saw the SDK default ("An error occurred."), so the chat's auto-resume
    // would silently dead-end with nothing to diagnose. We log full detail to
    // the Vercel function logs and return the real message to the client so
    // the UI can surface the actual cause.
    onError: (error) => {
      console.error("[api/chat] agent stream error:", {
        user: userEmail || "(unknown)",
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      const message = error instanceof Error ? error.message : String(error);
      const clean = message.replace(/\s+/g, " ").trim().slice(0, 300);
      return clean || "The assistant hit an error. Please try again.";
    },
  });
}

// Export type for the fully-equipped agent
export type FullGmccAgentUIMessage = InferAgentUIMessage<typeof _typeAgent>;
const _typeAgent = null as unknown as ToolLoopAgent<{
  searchProperties: typeof searchPropertiesTool;
  matchPrograms: typeof matchProgramsTool;
  lookupPrograms: typeof lookupProgramsTool;
  searchKnowledge: typeof searchKnowledgeTool;
  askForConfirmation: typeof askForConfirmationTool;
  askUser: typeof askUserTool;
  queryAdmiral: ReturnType<typeof createQueryAdmiralTool>;
  researchRealtor: ReturnType<typeof createResearchRealtorTool>;
  draftEmail: ReturnType<typeof createDraftEmailTool>;
  generateFlyer: ReturnType<typeof createGenerateFlyerTool>;
  sendEmail: ReturnType<typeof createSendEmailTool>;
  recordFollowUp: ReturnType<typeof createRecordFollowUpTool>;
  webSearch: ReturnType<typeof createWebSearchTool>;
}>;
