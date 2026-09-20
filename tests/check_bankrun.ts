import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function main() {
    const context = await startAnchor("", [], []);
    const account = await context.banksClient.getAccount(TOKEN_2022_PROGRAM_ID);
    console.log("Token-2022 account:", account);
}
main().catch(console.error);
