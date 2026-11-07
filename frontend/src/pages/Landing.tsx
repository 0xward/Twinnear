import { Link } from "react-router-dom";
import Reveal from "../components/Reveal";
import ProvenOnNear from "../components/ProvenOnNear";
import TrustStrip from "../components/TrustStrip";
import { EXPLORER_URL } from "../lib/config";
import { INVOICE_1_TX } from "../lib/invoiceTx";

/** The ten ways a client can pay, via 1Click (see lib/intents.ts). */
const PAY_OPTIONS = [
  "USDC on Base",
  "USDC on Ethereum",
  "USDC on Arbitrum",
  "USDC on Solana",
  "USDT on Ethereum",
  "ETH on Ethereum",
  "ETH on Arbitrum",
  "ETH on Base",
  "SOL on Solana",
  "BTC on Bitcoin",
];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Escrow, dispute, and refund",
    body: "The client pays into the contract, not to you. A dispute blocks the release. A refund goes back on chain.",
  },
  {
    title: "Gasless creation",
    body: "A single-line NEAR invoice costs the seller no gas. Sign a message in your wallet and a relayer submits it.",
  },
  {
    title: "Retainers",
    body: "Recurring invoices that create themselves, on a schedule you set. For clients who pay every month.",
  },
  {
    title: "Client portal",
    body: "Your client sees every invoice you sent them, in one place, with its status. No account needed to look.",
  },
  {
    title: "PDF and CSV",
    body: "Download a clean PDF for any invoice, or export the whole ledger as CSV for your books.",
  },
  {
    title: "Spend guard",
    body: "A max per invoice, a daily cap, and a seller allowlist. An emergency brake on what you can be charged.",
  },
  {
    title: "Line items and tax",
    body: "Break the total into items, add tax, and show the client exactly what they are paying for.",
  },
  {
    title: "Public invoice view",
    body: "Any invoice opens in a browser with no wallet. Share it, check it, verify it on the explorer.",
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
            {PAY_OPTIONS.map((option) => (
              <li key={option} className="stagger-item">
                {option}
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
            <div className="step stagger-item tint-blue">
              <div className="step-num" aria-hidden="true">
                01
              </div>
              <h3>Create an invoice</h3>
              <p>
                Amount in NEAR or USDC, line items and tax, a due date,
                and the client. A single-line invoice can be created
                gasless: you sign a message, a relayer submits it.
              </p>
            </div>
            <div className="step stagger-item tint-lavender">
              <div className="step-num" aria-hidden="true">
                02
              </div>
              <h3>Share the link</h3>
              <p>
                Send the pay link over WhatsApp or email. Your client
                opens it on their phone and pays. No account, no app to
                install.
              </p>
            </div>
            <div className="step stagger-item tint-teal">
              <div className="step-num" aria-hidden="true">
                03
              </div>
              <h3>Get paid</h3>
              <p>
                The payment sits in escrow until you release it on
                delivery. If things go wrong, refund the client, or the
                client claims a refund after the due date.
              </p>
            </div>
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
                  <td>Yes, on chain</td>
                  <td>Dispute, refund, or claim it back</td>
                </tr>
              </tbody>
            </table>
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
