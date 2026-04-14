/**
 * Convert tool events into natural spoken sentences for the TTS narrator.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOOL_NAMES: Record<string, string> = {
  searchProperties: "property search",
  lookupProperty: "property lookup",
  matchPrograms: "program matching",
  lookupPrograms: "program lookup",
  searchKnowledge: "knowledge search",
  queryAdmiral: "Admiral advisor",
  webSearch: "web search",
  researchRealtor: "realtor research",
  draftEmail: "email draft",
  sendEmail: "email send",
  generateFlyer: "flyer generation",
  recordFollowUp: "follow-up",
  searchByProgram: "program coverage search",
  generateCsv: "CSV export",
  checkCRAEligibility: "CRA eligibility check",
  searchSentEmails: "sent email search",
  fetchPropertyPhoto: "photo lookup",
};

function friendlyName(toolName: string): string {
  return TOOL_NAMES[toolName] ?? toolName;
}

function formatPrice(price: number): string {
  if (price >= 1_000_000) return `${(price / 1_000_000).toFixed(1).replace(/\.0$/, "")} million`;
  return `${Math.round(price / 1000)} thousand`;
}

/** What to say when a tool starts executing. */
export function summarizeToolStart(toolName: string, input: any): string {
  switch (toolName) {
    case "searchProperties": {
      const where = input?.city || input?.query || "the area";
      return `Searching for properties near ${where}.`;
    }
    case "lookupProperty":
      return `Looking up property at ${input?.address || "the address"}.`;
    case "matchPrograms":
      return "Checking which programs these properties qualify for.";
    case "lookupPrograms":
      return "Looking up available GMCC programs.";
    case "searchKnowledge":
      return `Searching knowledge base for ${input?.query || "information"}.`;
    case "queryAdmiral":
      return "Consulting Admiral for detailed program information.";
    case "webSearch":
      return `Searching the web for ${input?.query || "information"}.`;
    case "researchRealtor":
      return `Researching ${input?.agentName || "the listing agent"}.`;
    case "draftEmail":
      return "Drafting an email.";
    case "sendEmail":
      return `Sending email to ${input?.to || "recipient"}.`;
    case "generateFlyer":
      return `Generating a flyer for ${input?.programName || "the program"}.`;
    case "checkCRAEligibility":
      return `Checking CRA eligibility for ${input?.address || "the address"}.`;
    case "generateCsv":
      return "Preparing a CSV export.";
    case "fetchPropertyPhoto":
      return "Looking up a property photo.";
    default:
      return `Running ${friendlyName(toolName)}.`;
  }
}

/** What to say when a tool completes with output. */
export function summarizeToolResult(toolName: string, output: any): string {
  if (!output) return `${friendlyName(toolName)} completed.`;

  try {
    switch (toolName) {
      case "searchProperties": {
        const total = output.totalAvailable ?? output.showing ?? 0;
        const listings = output.listings as any[] | undefined;
        let priceInfo = "";
        if (listings?.length) {
          const prices = listings.map((l: any) => l.price).filter(Boolean) as number[];
          if (prices.length >= 2) {
            priceInfo = `, prices from ${formatPrice(Math.min(...prices))} to ${formatPrice(Math.max(...prices))}`;
          }
        }
        return `Found ${total} active listings${priceInfo}.`;
      }
      case "lookupProperty": {
        if (!output.found) return `No active listing found at that address.`;
        const price = output.price ? `, listed at ${formatPrice(output.price)}` : "";
        const type = output.propertyType ? ` ${output.propertyType}` : "";
        return `Found a${type} listing at ${output.address || "the address"}${price}.`;
      }
      case "matchPrograms": {
        const checked = output.totalChecked ?? 0;
        const eligible = output.totalWithEligiblePrograms ?? 0;
        return `${eligible} of ${checked} properties qualify for GMCC programs.`;
      }
      case "lookupPrograms": {
        const count = output.programs?.length ?? 0;
        return `${count} programs available.`;
      }
      case "queryAdmiral":
        return "Got a response from Admiral.";
      case "webSearch": {
        const count = output.results?.length ?? 0;
        return count > 0 ? `Found ${count} web results.` : "No relevant web results.";
      }
      case "researchRealtor":
        return `Finished researching ${output.name ?? output.agentName ?? "the realtor"}.`;
      case "draftEmail":
        return `Email drafted${output.subject ? `: ${output.subject}` : ""}.`;
      case "sendEmail":
        return output.error
          ? `Email failed: ${output.error}`
          : `Email sent to ${output.sentTo ?? "recipient"}.`;
      case "generateFlyer":
        return output.error ? `Flyer failed.` : `Flyer generated for ${output.programName ?? "the program"}.`;
      case "generateCsv":
        return `CSV ready with ${output.rowCount ?? 0} rows.`;
      case "checkCRAEligibility": {
        const eligible = output.eligible ?? output.isEligible;
        return eligible ? "This address is CRA eligible." : "This address is not CRA eligible.";
      }
      default:
        return `${friendlyName(toolName)} completed.`;
    }
  } catch {
    return `${friendlyName(toolName)} completed.`;
  }
}

/** What to say when a tool fails. */
export function summarizeToolError(toolName: string, errorText: string): string {
  return `${friendlyName(toolName)} ran into an error.`;
}
