import btcSvg from "../assets/btc.svg";
import ethSvg from "../assets/eth.svg";
import solSvg from "../assets/sol.svg";
import usdcSvg from "../assets/usdc.svg";
import usdtSvg from "../assets/usdt.svg";

/** A 1Click pay asset: the coin whose mark is shown in the pill. */
export type PayAsset = "USDC" | "USDT" | "ETH" | "SOL" | "BTC";

const ICONS: Record<PayAsset, string> = {
  USDC: usdcSvg,
  USDT: usdtSvg,
  ETH: ethSvg,
  SOL: solSvg,
  BTC: btcSvg,
};

/**
 * Official coin mark for a 1Click pay option, e.g. the USDC "$" coin
 * next to "USDC on Base". Local SVG files (no hotlink), same source
 * as the USDC mark in CurrencyIcon (cryptocurrency-icons, traced
 * from each project's official mark). Rendered at 18px so the mark
 * reads next to the pill text without dominating it.
 */
export default function PayAssetIcon({ asset }: { asset: PayAsset }) {
  return (
    <img
      src={ICONS[asset]}
      alt={asset}
      title={asset}
      className="pay-asset-icon"
    />
  );
}
