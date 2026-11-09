import { Link } from "react-router-dom";
import PayAssetIcon, { type PayAsset } from "../components/PayAssetIcon";
import CardWatermark, {
  type WatermarkIcon,
} from "../components/CardWatermark";
import Reveal from "../components/Reveal";
import Tilt from "../components/Tilt";
import ProvenOnNear from "../components/ProvenOnNear";
import TrustStrip from "../components/TrustStrip";
import { EXPLORER_URL } from "../lib/config";
import { INVOICE_1_TX } from "../lib/invoiceTx";

/** The ten ways a client can pay, via 1Click (see lib/intents.ts).
 * `asset` picks the coin mark shown at the left of the pill. */
const PAY_OPTIONS: { asset: PayAsset; label: string }[] = [
  { asset: "USDC", label: "USDC on Base" },
  { asset: "USDC", label: "USDC on Ethereum" },
  { asset: "USDC", label: "USDC on Arbitrum" },
  { asset: "USDC", label: "USDC on Solana" },
  { asset: "USDT", label: "USDT on Ethereum" },
  { asset: "ETH", label: "ETH on Ethereum" },
  { asset: "ETH", label: "ETH on Arbitrum" },
  { asset: "ETH", label: "ETH on Base" },
  { asset: "SOL", label: "SOL on Solana" },
  { asset: "BTC", label: "BTC on Bitcoin" },
];

const FEATURES: { title: string; body: string; wm: WatermarkIcon }[] = [
  {
    title: "Escrow, dispute, and refund",
    body: "The client pays into the contract, not to you. A dispute blocks the release. A refund goes back on chain.",
    wm: "shield",
  },
  {
    title: "Gasless creation",
    body: "For single-line NEAR invoices without tax, creation costs the seller no gas. Sign a message in your wallet and a relayer submits it.",
    wm: "gas",
  },
  {
    title: "Retainers",
    body: "Recurring invoices that create themselves, on a schedule you set. For clients who pay every month.",
    wm: "calendar",
  },
  {
    title: "Client portal",
    body: "Your client sees every invoice you sent them, in one place, with its status. No account needed to look.",
    wm: "people",
  },
  {
    title: "PDF and CSV",
    body: "Download a clean PDF for any invoice, or export the whole ledger as CSV for your books.",
    wm: "doc-check",
  },
  {
    title: "Spend guard",
    body: "A max per invoice, a daily cap, and a seller allowlist. An emergency brake on what you can be charged.",
    wm: "shield",
  },
  {
    title: "Line items and tax",
    body: "Break the total into items, add tax, and show the client exactly what they are paying for.",
    wm: "layers",
  },
  {
    title: "Public invoice view",
    body: "Any invoice opens in a browser with no wallet. Share it, check it, verify it on the explorer.",
    wm: "share",
  },
];

/** Feature-card tints, rotating through the logo palette so no two
 * neighbouring cards wear the same wash. */
const FEATURE_TINTS = [
  "tint-blue",
  "tint-lavender",
  "tint-teal",
  "tint-cream",
  "tint-green",
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <p className="hero-eyebrow">
          NEAR Hackathon · Real-World Money · Testnet
        </p>
        <h1>Freelancer invoicing, held in the middle.</h1>
        <p className="lede">
          Create an invoice, share one link, and get paid in NEAR or USDC.
          The money waits in the middle, held by the contract, until the
          work is done. No fees. No signup. No custody.
        </p>
        <div className="hero-ctas">
          <Link className="btn" to="/ledger">
            Open the app
          </Link>
          <Link className="btn btn-ghost" to="/invoice/1">
            See a real invoice
          </Link>
        </div>
        <p className="muted">
          Invoice #1 was created, paid, and released on chain. Open it.
          Nothing to install.
        </p>
      </section>

      <Reveal>
        <TrustStrip />
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">Your client pays with</p>
          <h2 className="section-title">The crypto they already hold.</h2>
          <p className="section-sub">
            Ten ways to pay, from any chain. NEAR Intents converts it to
            the exact invoice amount, in NEAR or USDC.
          </p>
          <ul className="pay-pills">
            {PAY_OPTIONS.map((option, i) => (
              <li key={option.label} className="stagger-item">
                <span
                  className="pill-bob"
                  style={{ animationDelay: `${(i * 0.18).toFixed(2)}s` }}
                >
                  <PayAssetIcon asset={option.asset} />
                  {option.label}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            A client with no NEAR at all can still pay a USDC invoice from
            Base, Ethereum, Arbitrum, or Solana.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">How it works</p>
          <h2 className="section-title">
            Three steps. The money moves through the contract, never
            through us.
          </h2>
          <div className="steps-grid">
            <Tilt className="step tint-blue">
              <CardWatermark tint="tint-blue" icon="doc-check" />
              <div className="step-num" aria-hidden="true">
                01
              </div>
              <h3>Create an invoice</h3>
              <p>
                Amount in NEAR or USDC, line items and tax, a due date,
                and the client. A single-line invoice can be created
                gasless: you sign a message, a relayer submits it.
              </p>
            </Tilt>
            <Tilt className="step tint-lavender">
              <CardWatermark tint="tint-lavender" icon="share" />
              <div className="step-num" aria-hidden="true">
                02
              </div>
              <h3>Share the link</h3>
              <p>
                Send the pay link over WhatsApp or email. Your client
                opens it on their phone and pays. No account, no app to
                install.
              </p>
            </Tilt>
            <Tilt className="step tint-teal">
              <CardWatermark tint="tint-teal" icon="cash" />
              <div className="step-num" aria-hidden="true">
                03
              </div>
              <h3>Get paid</h3>
              <p>
                The payment sits in escrow until you release it on
                delivery. If things go wrong, refund the client, or the
                client claims a refund after the due date.
              </p>
            </Tilt>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="landing-section example-band">
          <p className="section-eyebrow">A real example</p>
          <h2 className="section-title">Invoice #1, as it happened.</h2>
          <p className="section-sub">
            The first real invoice on the contract, written as three
            ledger lines. Every step is on chain.
          </p>
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Escrow movements for invoice TW-2026-0001
              </caption>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1. Client pays</td>
                  <td>0xward.testnet (client)</td>
                  <td>Contract escrow</td>
                  <td className="num">0.05 NEAR</td>
                </tr>
                <tr>
                  <td>2. Held</td>
                  <td>Contract escrow</td>
                  <td>Contract escrow</td>
                  <td className="num">0.05 NEAR, waiting</td>
                </tr>
                <tr>
                  <td>3. Seller releases</td>
                  <td>Contract escrow</td>
                  <td>twinnear.testnet (seller)</td>
                  <td className="num">0.05 NEAR</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            <a
              href={`${EXPLORER_URL}/transactions/${INVOICE_1_TX.pay}`}
              target="_blank"
              rel="noreferrer"
            >
              Payment
            </a>{" "}
            ·{" "}
            <a
              href={`${EXPLORER_URL}/transactions/${INVOICE_1_TX.release}`}
              target="_blank"
              rel="noreferrer"
            >
              Release
            </a>{" "}
            · <Link to="/invoice/1">Open invoice #1</Link>
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">
            Everything a freelancer needs
          </p>
          <h2 className="section-title">
            Not a payment link. A bookkeeper.
          </h2>
          <div className="feature-grid">
            {FEATURES.map((f, i) => (
              <div
                className={`feature-card stagger-item ${FEATURE_TINTS[i % FEATURE_TINTS.length]}`}
                key={f.title}
              >
                <CardWatermark
                  tint={FEATURE_TINTS[i % FEATURE_TINTS.length]}
                  icon={f.wm}
                />
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      <Reveal>
        <ProvenOnNear />
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">Why escrow</p>
          <h2 className="section-title">
            The old ways leave one side exposed.
          </h2>
          <div className="table-scroll">
            <table className="ledger">
              <caption className="visually-hidden">
                Old ways of getting paid, compared with Twinnear
              </caption>
              <thead>
                <tr>
                  <th scope="col"></th>
                  <th scope="col">Speed</th>
                  <th scope="col">Escrow</th>
                  <th scope="col">If things go wrong</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Bank transfer</td>
                  <td>Days</td>
                  <td>No</td>
                  <td>A support ticket</td>
                </tr>
                <tr>
                  <td>Plain crypto payment</td>
                  <td>Minutes</td>
                  <td>No</td>
                  <td>Nothing. The money is gone.</td>
                </tr>
                <tr>
                  <td>
                    <strong>Twinnear</strong>
                  </td>
                  <td>Minutes</td>
                  <td>Yes, on chain (NEAR only)</td>
                  <td>Dispute, refund, or claim it back</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">Why Twinnear</p>
          <h2 className="section-title">
            A ledger, not just a payment link.
          </h2>
          <p className="section-sub">
            A payment link moves money. Twinnear holds it, records it,
            and gives it a way out. Five things the demo proves, and one
            honest limit.
          </p>
          <div className="proof-list">
            <div className="stagger-item">
              <h3>A full lifecycle, not a dead end.</h3>
              <p>
                Escrow, dispute, refund, and rescue. Some escrows hold
                the money with no way out: if the client never approves,
                the funds sit forever. Twinnear&apos;s escrow always has
                an exit.
              </p>
            </div>
            <div className="stagger-item">
              <h3>Gasless, proven on chain.</h3>
              <p>
                Invoice #4 was created without the seller paying gas. A
                signed message, verified by the server, submitted by the
                relayer.{" "}
                <a
                  href={`${EXPLORER_URL}/transactions/2iMVmF156UnK3WR1nHJxnwgCYSisy8585NNGQtBKnXz4`}
                  target="_blank"
                  rel="noreferrer"
                >
                  See the transaction
                </a>
                .
              </p>
            </div>
            <div className="stagger-item">
              <h3>Funded milestones, shared releases.</h3>
              <p>
                Up to 5 milestones per invoice, funded up front and
                released as each part of the work is done — and every
                release split across up to 3 people, totalling exactly
                10000 bps. Proven on chain in{" "}
                <Link to="/invoice/12">invoice #12, split 90/10</Link>.
              </p>
            </div>
            <div className="stagger-item">
              <h3>Tested like it holds real money.</h3>
              <p>
                123 unit tests pass, including adversarial tests and a
                60-action random walk. No formal audit yet, and the docs
                say so plainly.
              </p>
            </div>
            <div className="stagger-item">
              <h3>Built for mainnet, rehearsed on testnet.</h3>
              <p>
                The same contract deploys to mainnet with no code change,
                and 1Click is mainnet-only, so the ten ways to pay become
                fully real there. This demo runs on testnet with play
                money from the faucet.{" "}
                <Link to="/docs">Read the mainnet guide</Link>.
              </p>
            </div>
            <div className="stagger-item">
              <h3>Honest about USDC.</h3>
              <p>
                A USDC invoice is paid straight to the seller and closed
                by the seller&apos;s own confirmation. It never enters
                escrow, so the full escrow protection applies to NEAR
                invoices. The invoice says so on the page.
              </p>
            </div>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="landing-section">
          <p className="section-eyebrow">Questions, first</p>
          <h2 className="section-title">
            The objections, answered plainly.
          </h2>
          <div className="faq-mini">
            <h3>But what if the seller disappears?</h3>
            <p>
              Your money is in escrow, held by the contract, not by the
              seller. A dispute blocks the release, and after the due
              date you can claim the refund yourself.
            </p>
            <h3>But what if my client never pays?</h3>
            <p>
              Nothing is lost. An unpaid invoice just stays Pending. No
              money has moved, so there is nothing to recover.
            </p>
            <h3>Is this real money?</h3>
            <p>
              No. Twinnear runs on NEAR testnet only. The NEAR here is
              play money from the faucet. The code is real, the contract
              is live, and the escrow works exactly as described.
            </p>
            <h3>What does it cost?</h3>
            <p>
              Nothing. No fees, no subscription, no signup. Creating an
              invoice costs a 0.01 NEAR storage deposit plus a little
              gas, both in testnet NEAR from the faucet.
            </p>
          </div>
          <p>
            <Link to="/faq">Read the full FAQ</Link>
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section className="cta-band">
          <h2>Start with a blank ledger.</h2>
          <p>
            No signup. No fees. No custody. Your wallet is your
            identity.
          </p>
          <div className="hero-ctas">
            <Link className="btn" to="/ledger">
              Open the app
            </Link>
            <Link className="btn btn-ghost" to="/docs">
              Read the guides
            </Link>
          </div>
        </section>
      </Reveal>
    </div>
  );
}
