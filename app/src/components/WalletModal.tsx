import type { WalletState } from "../lib/wallet";
import { short } from "../lib/genlayer";

export function WalletModal({
  wallet,
  onClose,
}: {
  wallet: WalletState;
  onClose: () => void;
}) {
  const { options, connected, address, connecting, error, wrongChain } = wallet;

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wallet__head">
          <h2 className="wallet__title">
            {address ? "Wallet" : "Connect a wallet"}
          </h2>
          <p className="wallet__sub">
            {address
              ? "Signing happens inside your wallet. This page never holds a key."
              : "Pick the wallet you want to sign with. Every injected wallet that announces itself is listed."}
          </p>
        </div>

        {address && connected && (
          <div className="wallet__current">
            <div className="wallet__row">
              <span className="wallet__k">Account</span>
              <span className="wallet__v">{short(address, 6)}</span>
            </div>
            <div className="wallet__row">
              <span className="wallet__k">Wallet</span>
              <span className="wallet__v">{connected.name}</span>
            </div>
            <div className="wallet__row">
              <span className="wallet__k">Network</span>
              <span className="wallet__v">
                {wrongChain ? (
                  <span style={{ color: "var(--v-inconclusive)" }}>
                    wrong network — chain {wallet.chainId}
                  </span>
                ) : (
                  "Bradbury Testnet"
                )}
              </span>
            </div>
            <div className="actions" style={{ marginTop: 14 }}>
              {wrongChain && (
                <button className="btn btn--primary" onClick={wallet.switchChain}>
                  Switch to Bradbury
                </button>
              )}
              <button
                className="btn btn--ghost"
                onClick={() => {
                  wallet.disconnect();
                  onClose();
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {!address && (
          <div className="cmd__list">
            {options.length === 0 && (
              <div className="wallet__empty">
                No wallet detected in this browser. Install an EVM wallet
                extension, reload the page, and it will appear here.
              </div>
            )}
            {options.map((option) => (
              <button
                key={option.rdns}
                className="cmd__item"
                disabled={connecting}
                onClick={async () => {
                  await wallet.connect(option);
                  onClose();
                }}
              >
                <span className="cmd__glyph">
                  {option.icon ? (
                    <img className="wallet__icon" src={option.icon} alt="" />
                  ) : (
                    "◈"
                  )}
                </span>
                <span>
                  <span className="cmd__label">{option.name}</span>
                  <span className="cmd__desc">{option.rdns}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="wallet__error">{error}</div>}

        <div className="cmd__foot">
          <span>Bradbury testnet · chain 4221</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
