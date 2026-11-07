import { Link } from "react-router-dom";
import { CONTRACT_ID, EXPECTED_WASM_SHA256, EXPLORER_URL } from "../lib/config";
import { INVOICE_1_TX } from "../lib/invoiceTx";
import CurrencyIcon from "../components/CurrencyIcon";

function txLink(hash: string, label: string) {
  return (
    <a
      href={`${EXPLORER_URL}/transactions/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="mono"
      style={{ wordBreak: "break-all" }}
    >
      {label}
    </a>
  );
}

export default function About() {
  return (
    <div>
      <div className="page-head">
        <h1>About Twinnear</h1>
        <p className="muted">
          Invoicing for freelancers, on NEAR. Your money waits in the
          middle, with a contract that cannot run away with it.
        </p>
      </div>

      <div className="card">
        <h2>What is Twinnear</h2>
        <p>
          Twinnear is invoicing for freelancers on NEAR testnet. A
          freelancer creates an invoice, shares a payment link, and the
          client pays. The payment sits in escrow until the freelancer
          releases it on delivery, or refunds it. A client can pay in
          NEAR, or pay in USDC from another chain through NEAR Intents
          (1Click) without holding NEAR.
        </p>
        <p>
          There is no signup and no account to create. You connect a
          NEAR testnet wallet, and that wallet is your identity. There
          are no fees: Twinnear takes nothing from any payment.
        </p>
        <p>
          This is a NEAR Hackathon submission for the Real-World Money
          track. It runs on testnet only. The NEAR you see here is play
          money from the testnet faucet. The code is real.
        </p>
      </div>

      <div className="card">
        <h2>How it works</h2>
        <p className="sub">
          Three steps. The money moves through the contract, never
          through us.
        </p>
        <ol className="steps">
          <li>
            <span>
              <strong>Create and share.</strong> The freelancer creates
              an invoice for the client and shares the pay link.
            </span>
          </li>
          <li>
            <span>
              <strong>The client pays into escrow.</strong> The exact
              amount goes to the contract, not to the freelancer. It
              waits there.
            </span>
          </li>
          <li>
            <span>
              <strong>Release or refund.</strong> When the work is
              delivered, the freelancer releases the escrow to
              themselves. If things go wrong, the freelancer refunds
              the client, or the client claims a refund after the due
              date.
            </span>
          </li>
        </ol>
        <h3 style={{ margin: "18px 0 8px" }}>
          The escrow, as a ledger entry
        </h3>
        <p className="sub">
          Every movement of invoice #1, the first real invoice on the
          contract, written as three ledger lines.
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
                <td className="num">
                  0.05 <CurrencyIcon currency="Near" />
                </td>
              </tr>
              <tr>
                <td>2. Held</td>
                <td>Contract escrow</td>
                <td>Contract escrow</td>
                <td className="num">
                  0.05 <CurrencyIcon currency="Near" />, waiting. The
                  contract cannot spend it.
                </td>
              </tr>
              <tr>
                <td>3. Seller releases</td>
                <td>Contract escrow</td>
                <td>twinnear.testnet (seller)</td>
                <td className="num">
                  0.05 <CurrencyIcon currency="Near" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          If the seller had refunded instead, the same 0.05 NEAR would
          have gone back to the client. The contract only moves money
          to the seller or back to the client, never anywhere else.
        </p>
      </div>

      <div className="card">
        <h2>Invoice #1, a living artifact</h2>
        <p className="sub">
          The first real invoice on the contract, created, paid, and
          released on 7 November 2026. Every step is on chain.
        </p>
        <dl className="kv">
          <dt>Reference</dt>
          <dd>
            <Link to="/invoice/1">TW-2026-0001</Link>
          </dd>
          <dt>Amount</dt>
          <dd>0.05 NEAR</dd>
          <dt>Client</dt>
          <dd>0xward.testnet</dd>
          <dt>Seller</dt>
          <dd>twinnear.testnet</dd>
          <dt>Description</dt>
          <dd>Design work, Framework, Testing</dd>
          <dt>Created</dt>
          <dd>
            7 Nov 2026, 10:12 WIB ·{" "}
            {txLink(
              INVOICE_1_TX.create,
              "14nev3LUrvanzZvVQc25373q85NCeKD7Ee5PEQ6ps8yP",
            )}
          </dd>
          <dt>Paid</dt>
          <dd>
            7 Nov 2026, 10:51 WIB ·{" "}
            {txLink(
              INVOICE_1_TX.pay,
              "GWzwgrctqSBdYhG79LSo5BM1RwU8RxQBBVyyT7bpQTLA",
            )}
          </dd>
          <dt>Released</dt>
          <dd>
            7 Nov 2026, 11:02 WIB ·{" "}
            {txLink(
              INVOICE_1_TX.release,
              "ARUyJbgZTvdgTtR58p2F8PPTDKB977TjpLMyweziwRNJ",
            )}
          </dd>
        </dl>
        <p className="muted" style={{ marginTop: 10 }}>
          The invoice survived the v1 to v2 migration unchanged, on the
          same day it was created. Open it as anyone can, no wallet
          needed: <Link to="/invoice/1">the public view</Link>.
        </p>
      </div>

      <div className="card">
        <h2>Live status</h2>
        <dl className="kv">
          <dt>Contract</dt>
          <dd>
            <a
              href={`${EXPLORER_URL}/accounts/${CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              {CONTRACT_ID}
            </a>
          </dd>
          <dt>Schema</dt>
          <dd>Version 4</dd>
          <dt>Wasm SHA-256</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>
            {EXPECTED_WASM_SHA256}
          </dd>
          <dt>First deployed</dt>
          <dd>7 November 2026, upgraded to v4 the same day</dd>
          <dt>Tests</dt>
          <dd>90 unit tests pass</dd>
          <dt>Network</dt>
          <dd>NEAR testnet only</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Disclosure</h2>
        <p>
          Twinnear is a port of TwinPayAI, an agentic-payments project
          on Stacks by the same author, to NEAR. Only the NEAR
          integration is new: the Rust contract, the NEAR Wallet
          Selector login, and the 1Click and relayer design. The payment
          flow, the vault and policy-engine concept, and the ledger UI
          pattern are carried over from TwinPayAI.
        </p>
        <p>
          TwinPayAI used a Groq AI decision engine. It is not in this
          build. This build is payments only. There is no AI here.
        </p>
      </div>

      <div className="card">
        <h2>Honest limitations</h2>
        <p>
          Twinnear is a hackathon build on testnet. These are the limits
          you should know before you trust it.
        </p>
        <ul className="plain-list">
          <li>
            <strong>No automatic refunds.</strong> A NEAR contract
            cannot wake itself up. If a seller goes silent, the client
            must click Claim refund after the due date, or open a
            dispute. An invoice with no deadline has no claim-refund
            escape at all.
          </li>
          <li>
            <strong>External (1Click) confirmations are unverified.</strong>{" "}
            The seller closes the invoice by saying payment arrived.
            The contract cannot check the 1Click swap. The UI labels
            these Paid, external (unverified).
          </li>
          <li>
            <strong>
              The spend guard protects NEAR payments in full, and USDC
              payments in full too — except the receipt.
            </strong>{" "}
            For a NEAR invoice, your max per invoice, your daily cap,
            and your seller allowlist are all enforced, at creation
            and at payment. For a USDC invoice, your own USDC caps
            apply in micro-USDC: a max per invoice at creation, a
            daily cap when the seller confirms the external payment,
            and the same allowlist. There is still no escrow for USDC:
            it settles via 1Click, and the seller closes the invoice
            by saying payment arrived, which nothing on chain verifies.
            A policy change can also make a previously created invoice
            unpayable. That is the point of the guard, an emergency
            brake, not a bug.
          </li>
          <li>
            <strong>The relayer is trusted for gasless creation.</strong>{" "}
            It checks signatures off chain. The contract checks them on
            chain too, so a compromised relayer cannot forge a
            seller&apos;s invoice, but it can refuse service.
          </li>
          <li>
            <strong>No formal audit.</strong> The contract has 90 unit
            tests and a QA review, but no third-party audit.
          </li>
          <li>
            <strong>There is no browser deploy.</strong> Meteor Wallet
            refuses the DeployContract action, so deploys go through
            the terminal.
          </li>
        </ul>
        <p>
          Questions about any of this? Read the{" "}
          <Link to="/faq">FAQ</Link> or the{" "}
          <Link to="/docs">guides</Link>.
        </p>
      </div>
    </div>
  );
}
