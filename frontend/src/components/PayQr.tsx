import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

/**
 * QR code for a pay link, drawn in the ledger palette (ink on white).
 * If QR generation fails, the component renders nothing — the copyable
 * link next to it is the fallback.
 */
export default function PayQr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 296,
      color: { dark: "#1c1a17", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (alive) setSrc(dataUrl);
      })
      .catch(() => {
        /* link remains the fallback */
      });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!src) return null;

  return (
    <figure className="qr-box">
      <img src={src} alt={`QR code for the payment link ${url}`} />
      <figcaption>Scan to pay</figcaption>
    </figure>
  );
}
