import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import type { Eip1193Provider } from "./wallet";

export const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS ??
  "") as `0x${string}`;

export const EXPLORER = "https://explorer-bradbury.genlayer.com";
export const FAUCET = "https://testnet-faucet.genlayer.foundation/";

/**
 * Built with an *address*, never a key. genlayer-js sees a non-object account
 * and routes `eth_sendTransaction` to the wallet provider, so every signature
 * happens inside the wallet and the page never holds anything secret.
 * Without an address the client is read-only, which is all the ledger needs.
 */
export function makeClient(address?: `0x${string}`, provider?: Eip1193Provider) {
  return createClient({
    chain: testnetBradbury,
    account: address,
    provider: provider as any,
  });
}

export const GEN = 10n ** 18n;

export function toGen(atto: string | bigint | number): string {
  const value = BigInt(atto ?? 0);
  const whole = value / GEN;
  const frac = (value % GEN).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

export function parseGen(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) throw new Error("bad amount");
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * GEN + BigInt(frac.padEnd(18, "0"));
}

export function short(address?: string, size = 4): string {
  if (!address) return "—";
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}
