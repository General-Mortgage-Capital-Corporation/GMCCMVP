import { tool } from "ai";
import { z } from "zod";

export const calculateRateTool = tool({
  description:
    "Calculate mortgage payment details: monthly payment, total interest, and loan comparison. " +
    "Use this when the user asks about payments, affordability, or wants to compare loan options. " +
    "Note: this uses standard amortization formulas. For actual GMCC program rates, use queryAdmiral.",
  inputSchema: z.object({
    loanAmount: z.number().describe("Loan amount in dollars"),
    interestRate: z.number().describe("Annual interest rate as a percentage (e.g., 6.5 for 6.5%)"),
    loanTermYears: z.number().default(30).describe("Loan term in years (default 30)"),
    propertyPrice: z.number().optional().describe("Purchase price (to calculate LTV and down payment)"),
    // Optional comparison
    comparisonRate: z
      .number()
      .optional()
      .describe("A second interest rate to compare against (e.g., conventional rate vs CRA rate)"),
    comparisonLabel: z
      .string()
      .optional()
      .describe("Label for the comparison rate (e.g., 'Conventional')"),
  }),
  execute: async ({ loanAmount, interestRate, loanTermYears, propertyPrice, comparisonRate, comparisonLabel }) => {
    function calcMonthly(principal: number, annualRate: number, years: number) {
      const monthlyRate = annualRate / 100 / 12;
      const numPayments = years * 12;
      if (monthlyRate === 0) return principal / numPayments;
      return (
        (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
        (Math.pow(1 + monthlyRate, numPayments) - 1)
      );
    }

    const monthlyPayment = calcMonthly(loanAmount, interestRate, loanTermYears);
    const totalPayments = monthlyPayment * loanTermYears * 12;
    const totalInterest = totalPayments - loanAmount;

    const result: Record<string, unknown> = {
      loanAmount: `$${loanAmount.toLocaleString()}`,
      interestRate: `${interestRate}%`,
      loanTerm: `${loanTermYears} years`,
      monthlyPayment: `$${Math.round(monthlyPayment).toLocaleString()}`,
      totalInterest: `$${Math.round(totalInterest).toLocaleString()}`,
      totalCost: `$${Math.round(totalPayments).toLocaleString()}`,
    };

    if (propertyPrice) {
      const downPayment = propertyPrice - loanAmount;
      const ltv = (loanAmount / propertyPrice) * 100;
      result.propertyPrice = `$${propertyPrice.toLocaleString()}`;
      result.downPayment = `$${downPayment.toLocaleString()} (${Math.round(100 - ltv)}%)`;
      result.ltv = `${Math.round(ltv * 10) / 10}%`;
    }

    // Comparison calculation
    if (comparisonRate != null) {
      const compMonthly = calcMonthly(loanAmount, comparisonRate, loanTermYears);
      const compTotal = compMonthly * loanTermYears * 12;
      const compTotalInterest = compTotal - loanAmount;
      const monthlySavings = compMonthly - monthlyPayment;
      const totalSavings = compTotalInterest - totalInterest;

      result.comparison = {
        label: comparisonLabel ?? "Comparison",
        rate: `${comparisonRate}%`,
        monthlyPayment: `$${Math.round(compMonthly).toLocaleString()}`,
        totalInterest: `$${Math.round(compTotalInterest).toLocaleString()}`,
        monthlySavings: `$${Math.round(Math.abs(monthlySavings)).toLocaleString()} ${monthlySavings > 0 ? "saved" : "more"}/month`,
        totalSavings: `$${Math.round(Math.abs(totalSavings)).toLocaleString()} ${totalSavings > 0 ? "saved" : "more"} over ${loanTermYears} years`,
      };
    }

    return result;
  },
});
