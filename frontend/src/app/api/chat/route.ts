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
import { SYSTEM_PROMPT } from "@/lib/agents/gmcc-agent";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Extract auth context from headers
  const firebaseToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const msalToken = req.headers.get("X-MSAL-Token") ?? "";
  const userEmail = req.headers.get("X-User-Email") ?? "";

  // Decode email signature (base64 UTF-8 from client)
  const sigHeader = req.headers.get("X-Email-Signature") ?? "";
  let signatureHtml = "";
  if (sigHeader) {
    try {
      signatureHtml = decodeURIComponent(escape(atob(sigHeader)));
    } catch { /* ignore decode errors */ }
  }

  const authContext = { firebaseToken, msalToken, userEmail, signatureHtml };

  // Construct agent per-request with auth-bound tools
  const agent = new ToolLoopAgent({
    model: "google/gemini-3-flash",
    instructions: SYSTEM_PROMPT,
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
    },
    stopWhen: stepCountIs(25),
    temperature: 0.3,
  });

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
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
