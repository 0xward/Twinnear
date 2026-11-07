import { Link } from "react-router-dom";
import Reveal from "../components/Reveal";

export default function Faq() {
  return (
    <div>
      <div className="page-head">
        <h1>Frequently asked questions</h1>
        <p className="muted">
          The objections first, answered plainly. If your question is
          not here, read the{" "}
          <Link to="/docs">guides</Link> or the{" "}
          <Link to="/about">about page</Link>.
        </p>
      </div>

      <Reveal>
      <div className="card">
        <h2>But what if the seller disappears?</h2>
        <p>
          Your money is in escrow, held by the contract, not by the
          seller. The seller cannot take it without releasing it, and
          a dispute blocks the release. If the due date has passed and
          the seller stays silent, click Claim refund on the invoice
          page and the escrow comes back to you.
        </p>
        <p>
          One exception: an invoice with no due date has no
          claim-refund escape. A dispute is your only protection then,
          besides asking the seller for a refund. Pay a dateless
          invoice only if you trust the seller.
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>But what if my client never pays?</h2>
        <p>
          Nothing is lost. An unpaid invoice just stays Pending. No
          money has moved, so there is nothing to recover. Send a
          reminder from the invoice page, wait for the due date if you
          set one, and cancel the invoice if the work is off. Only
          you, the seller, can cancel, and only while it is still
          Pending.
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>Can I get my money back?</h2>
        <p>
          As a client: yes, if the invoice is paid and still in
          escrow. Ask the seller to refund you, or open a dispute to
          block the release, or claim the refund yourself after the
          due date has passed. As a seller: you can refund the client
          any time while the invoice is paid and unreleased, even
          while a dispute is open.
        </p>
        <p>
          Once the escrow is released, the payment is final. There is
          no way to pull it back through the contract.
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>Do I need NEAR to get paid in USDC?</h2>
        <p>
          No. A client can pay a USDC invoice with USDC from another
          chain, for example Base, through 1Click. They never need to
          hold NEAR, and the seller receives USDC straight to their
          account. A USDC invoice never goes into escrow, because the
          contract cannot hold USDC.
        </p>
        <p>
          1Click is mainnet only and has no testnet, so on testnet
          this flow is closed by the seller&apos;s own confirmation,
          labelled Paid, external (unverified).
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>Does the spend guard protect USDC payments?</h2>
        <p>
          Yes, with one exception. For a NEAR invoice, the guard
          protects you in full: your max per invoice, your daily cap,
          and your seller allowlist are all enforced. For a USDC
          invoice, your own USDC caps apply in micro-USDC: a max per
          invoice at creation, a daily cap when the seller confirms
          the external payment, and the same allowlist.
        </p>
        <p>
          The exception is the receipt itself. A USDC invoice settles
          straight to the seller through 1Click and is closed by the
          seller&apos;s own confirmation, which nothing on chain
          verifies. The caps limit how much a seller can invoice and
          confirm, but they cannot prove the money arrived. So a USDC
          invoice is not as safe as a NEAR one. Pay one only if you
          trust the seller, or set an allowlist that keeps sellers
          you do not trust from invoicing you at all.
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>Is this real money?</h2>
        <p>
          No. Twinnear runs on NEAR testnet only. The NEAR here is
          play money from the testnet faucet. It has no value, and
          nothing you do here moves real money. The code is real, the
          contract is live on testnet, and the escrow works exactly as
          described, but treat every balance as a demo.
        </p>
      </div>
      </Reveal>

      <Reveal>
      <div className="card">
        <h2>What does it cost?</h2>
        <p>
          Nothing. There are no fees, no subscription, and no signup.
          Creating an invoice costs a 0.01 NEAR storage deposit plus a
          little gas, both paid in testnet NEAR from the faucet. A
          single-line NEAR invoice can also be created gasless: you
          sign a message in your wallet and a relayer submits it. Get
          testnet NEAR at{" "}
          <a
            href="https://near-faucet.io"
            target="_blank"
            rel="noreferrer"
          >
            near-faucet.io
          </a>
          .
        </p>
      </div>
      </Reveal>
    </div>
  );
}
