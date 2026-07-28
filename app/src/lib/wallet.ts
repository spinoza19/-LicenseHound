/**
 * Wallet adapter.
 *
 * The app never sees a private key. Discovery is EIP-6963, so every injected
 * wallet announces itself and the user picks one — rather than the app assuming
 * `window.ethereum` is the wallet they meant, which breaks the moment two
 * extensions are installed. Signing stays inside the wallet: genlayer-js routes
 * `eth_sendTransaction` to the provider whenever the client is built with an
 * address rather than a local account.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { testnetBradbury } from "genlayer-js/chains";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

export type WalletOption = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
};

const LAST_WALLET = "licensehound.wallet";

/**
 * An earlier build kept a private key in localStorage. Anyone who used it still
 * has that key sitting in their browser, so wipe it on load — removing the code
 * that wrote it does nothing for people who already ran it.
 */
try {
  localStorage.removeItem("licensehound.pk");
} catch {
  /* storage can be blocked; nothing to clean up in that case */
}

export const CHAIN_ID = testnetBradbury.id; // 4221
export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;

const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: testnetBradbury.name,
  rpcUrls: [...testnetBradbury.rpcUrls.default.http],
  nativeCurrency: testnetBradbury.nativeCurrency,
  blockExplorerUrls: [testnetBradbury.blockExplorers?.default.url],
};

/** EIP-6963: ask every installed wallet to announce itself. */
function discover(onFound: (option: WalletOption) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.info?.uuid || !detail?.provider) return;
    onFound({
      uuid: detail.info.uuid,
      name: detail.info.name,
      icon: detail.info.icon,
      rdns: detail.info.rdns,
      provider: detail.provider,
    });
  };

  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Wallets that predate EIP-6963 only ever set window.ethereum.
  const legacy = (window as any).ethereum;
  if (legacy) {
    onFound({
      uuid: "legacy-injected",
      name: legacy.isMetaMask ? "MetaMask" : "Injected wallet",
      icon: "",
      rdns: "legacy.injected",
      provider: legacy,
    });
  }

  return () => window.removeEventListener("eip6963:announceProvider", handler);
}

async function switchOrAddChain(provider: Eip1193Provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (error: any) {
    // 4902 = the wallet has never heard of this chain
    const code = error?.code ?? error?.data?.originalError?.code;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [CHAIN_PARAMS],
    });
  }
}

export type WalletState = {
  options: WalletOption[];
  connected?: WalletOption;
  address?: `0x${string}`;
  chainId?: number;
  wrongChain: boolean;
  connecting: boolean;
  error?: string;
  connect: (option: WalletOption) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
};

export function useWallet(): WalletState {
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [connected, setConnected] = useState<WalletOption>();
  const [address, setAddress] = useState<`0x${string}`>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const resumed = useRef(false);

  useEffect(
    () =>
      discover((option) =>
        setOptions((prev) =>
          prev.some((o) => o.rdns === option.rdns) ? prev : [...prev, option],
        ),
      ),
    [],
  );

  const attach = useCallback(async (option: WalletOption, accounts: string[]) => {
    setConnected(option);
    setAddress(accounts[0] as `0x${string}`);
    const hex = await option.provider.request({ method: "eth_chainId" });
    setChainId(Number(hex));
    localStorage.setItem(LAST_WALLET, option.rdns);
  }, []);

  const connect = useCallback(
    async (option: WalletOption) => {
      setConnecting(true);
      setError(undefined);
      try {
        const accounts: string[] = await option.provider.request({
          method: "eth_requestAccounts",
        });
        if (!accounts?.length) throw new Error("the wallet returned no accounts");
        await attach(option, accounts);
      } catch (e: any) {
        setError(e?.message ?? "connection rejected");
      } finally {
        setConnecting(false);
      }
    },
    [attach],
  );

  // Silently resume the wallet used last time, if it is still authorised.
  useEffect(() => {
    if (resumed.current || options.length === 0) return;
    const remembered = localStorage.getItem(LAST_WALLET);
    if (!remembered) return;
    const option = options.find((o) => o.rdns === remembered);
    if (!option) return;
    resumed.current = true;
    option.provider
      .request({ method: "eth_accounts" })
      .then((accounts: string[]) => {
        if (accounts?.length) void attach(option, accounts);
      })
      .catch(() => undefined);
  }, [options, attach]);

  // Track account and network changes made inside the wallet itself.
  useEffect(() => {
    const provider = connected?.provider;
    if (!provider?.on) return;

    const onAccounts = (accounts: string[]) => {
      if (!accounts?.length) {
        setConnected(undefined);
        setAddress(undefined);
        localStorage.removeItem(LAST_WALLET);
      } else {
        setAddress(accounts[0] as `0x${string}`);
      }
    };
    const onChain = (hex: string) => setChainId(Number(hex));

    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [connected]);

  const switchChain = useCallback(async () => {
    if (!connected) return;
    setError(undefined);
    try {
      await switchOrAddChain(connected.provider);
      const hex = await connected.provider.request({ method: "eth_chainId" });
      setChainId(Number(hex));
    } catch (e: any) {
      setError(e?.message ?? "the wallet refused to switch network");
    }
  }, [connected]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(LAST_WALLET);
    setConnected(undefined);
    setAddress(undefined);
    setChainId(undefined);
    resumed.current = true;
  }, []);

  return useMemo(
    () => ({
      options,
      connected,
      address,
      chainId,
      wrongChain: Boolean(address) && chainId !== undefined && chainId !== CHAIN_ID,
      connecting,
      error,
      connect,
      disconnect,
      switchChain,
    }),
    [options, connected, address, chainId, connecting, error, connect, disconnect, switchChain],
  );
}
