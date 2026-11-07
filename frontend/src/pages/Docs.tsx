import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

function GuideLink({ to, children }: { to: string; children: string }) {
  return <Link to={to}>{children}</Link>;
}

export default function Docs() {
  const location = useLocation();

  // Jump to a guide when the link carries an anchor, e.g. /docs#paying-an-invoice.
  useEffect(() => {
    if (!location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) el.scrollIntoView();
  }, [location.hash]);

  return (
    <div>
      <div className="page-head">
        <h1>Guides</h1>
        <p className="muted">
          Pattern guides, not an API list. Find your job below, then
          follow the steps. Developers looking for contract methods can
          read the Contract API table in the{" "}
          <a
            href="https://github.com/0xward/Twinnear#contract-api"
            target="_blank"
            rel="noreferrer"
          >
            README
          </a>
          .
        </p>
      </div>

      <div className="card">
        <h2>Find your job</h2>
        <dl className="kv">
          <dt>I want to get paid</dt>
          <dd>
            <GuideLink to="#first-invoice">
              Send your first invoice
            </GuideLink>{" "}
            ·{" "}
            <GuideLink to="#usdc">
              Get paid in USDC from another chain
            </GuideLink>
          </dd>
          <dt>I want to pay someone</dt>
          <dd>
            <GuideLink to="#paying-an-invoice">
              Paying an invoice (for clients)
            </GuideLink>
          </dd>
          <dt>I want to protect myself</dt>
          <dd>
            <GuideLink to="#spend-guard">Set a spend guard</GuideLink>{" "}
            ·{" "}
            <GuideLink to="#client-doesnt-pay">
              What happens if a client doesn&apos;t pay
            </GuideLink>
          </dd>
          <dt>I want to keep my books</dt>
          <dd>
            <GuideLink to="#books">Keep your books</GuideLink>
          </dd>
          <dt>I want to move to mainnet</dt>
          <dd>
            <GuideLink to="#mainnet-readiness">
              Move to mainnet
            </GuideLink>
          </dd>
        </dl>
      </div>

      <div className="card guide" id="first-invoice">
        <p className="filed-under">Filed under: Get paid</p>
        <h2>Send your first invoice</h2>
        <p>
          <strong>When to use it:</strong> you did work for a client
          and want to be paid in NEAR, with the money held safely until
          you release it.
        </p>
        <ol className="steps">
          <li>
            <span>
              Connect a testnet wallet (Meteor) and open{" "}
              <Link to="/invoices/new">New invoice</Link>.
            </span>
          </li>
          <li>
            <span>
              Enter the client&apos;s account, the amount, and a short
              description. Add line items and tax if you need them, and
              a due date if you want one.
            </span>
          </li>
          <li>
            <span>
              Create the invoice. It costs a 0.01 NEAR storage deposit
              plus a little gas. A single-line NEAR invoice can also be
              created gasless: you sign a message in your wallet and a
              relayer submits it.
            </span>
          </li>
          <li>
            <span>
              Share the pay link with your client. It looks like
              twinnear.vercel.app/#/pay/1.
            </span>
          </li>
          <li>
            <span>
              When the client pays, the money sits in escrow. When the
              work is delivered, click Release to me. If things go
              wrong, click Refund client.
            </span>
          </li>
        </ol>
        <p className="muted">
          Limits: an invoice needs a due date if you want the client to
          have a claim-refund escape. Without one, only a dispute or
          your own refund can move the money back.
        </p>
      </div>

      <div className="card guide" id="usdc">
        <p className="filed-under">Filed under: Get paid</p>
        <h2>Get paid in USDC from another chain</h2>
        <p>
          <strong>When to use it:</strong> your client holds USDC on
          another chain, for example Base, and does not want to buy
          NEAR first.
        </p>
        <ol className="steps">
          <li>
            <span>
              Create the invoice in USDC instead of NEAR. A USDC
              invoice is denominated in micro-USDC (6 decimals).
            </span>
          </li>
          <li>
            <span>
              Share the pay link. The client opens it, picks the chain
              and asset they pay with, and gets a live 1Click quote.
            </span>
          </li>
          <li>
            <span>
              The client sends the quoted amount to the 1Click deposit
              address. 1Click delivers the exact USDC amount straight
              to your account.
            </span>
          </li>
          <li>
            <span>
              Once the USDC has landed, close the invoice with Confirm
              I received payment. This records the deposit address as
              the reference.
            </span>
          </li>
        </ol>
        <p className="muted">
          Limits: 1Click is mainnet only and has no testnet, so on
          testnet this flow is shown with the seller&apos;s own
          confirmation. A USDC invoice never goes into escrow, because
          the contract cannot hold USDC. The confirmation is your own
          attestation: nothing on chain verifies the payment, and the
          invoice is labelled Paid, external (unverified).
        </p>
      </div>

      <div className="card guide" id="spend-guard">
        <p className="filed-under">Filed under: Protect myself</p>
        <h2>Set a spend guard</h2>
        <p>
          <strong>When to use it:</strong> you want a lock on your own
          wallet, so no one can charge you more than you allow. Think
          of it as a personal rulebook, not a settings page.
        </p>
        <p>
          Open <Link to="/spend-guard">Spend guard</Link> and set your
          rules. Three examples:
        </p>
        <ul className="plain-list">
          <li>
            <strong>Never pay more than 5 NEAR per invoice.</strong>{" "}
            Any NEAR invoice above your max is refused at creation and
            at payment.
          </li>
          <li>
            <strong>No more than 10 NEAR a day.</strong> Once your
            daily cap is reached, further NEAR payments that day are
            refused.
          </li>
          <li>
            <strong>Only these sellers can charge me.</strong> An
            allowlist of seller accounts. Anyone not on the list cannot
            invoice you at all, in NEAR or in USDC.
          </li>
        </ul>
        <p className="muted">
          Limits: the guard protects NEAR payments in full, and USDC
          payments in full too, except the receipt. For a USDC
          invoice, your own USDC caps apply in micro-USDC: a max
          amount per invoice at creation and a daily cap at
          confirmation, plus the allowlist. There is no escrow for
          USDC, and the seller&apos;s confirmation that payment
          arrived is attested, not verified on chain. The guard also
          does not cover external (1Click) payments in the sense of
          verifying them. A policy change can make a previously
          created invoice unpayable. That is the point of the guard,
          an emergency brake, not a bug.
        </p>
      </div>

      <div className="card guide" id="client-doesnt-pay">
        <p className="filed-under">Filed under: Protect myself</p>
        <h2>What happens if a client doesn&apos;t pay</h2>
        <p>
          <strong>Short answer:</strong> nothing is lost. An unpaid
          invoice just stays Pending. No money has moved, so there is
          nothing to recover.
        </p>
        <ol className="steps">
          <li>
            <span>
              Send a reminder. Open the invoice and use Copy reminder
              for a short message with the invoice number, amount, and
              pay link, ready to paste.
            </span>
          </li>
          <li>
            <span>
              Wait for the due date, if you set one. The client can
              still pay until you cancel.
            </span>
          </li>
          <li>
            <span>
              Cancel the invoice if the work is off. Only you, the
              seller, can cancel, and only while it is still Pending.
              No funds move.
            </span>
          </li>
        </ol>
        <p className="muted">
          For repeat clients, use retainers: a recurring template that
          generates the invoices that are due, one click at a time.
          Retainers are kept in your browser, not on chain.
        </p>
      </div>

      <div className="card guide" id="paying-an-invoice">
        <p className="filed-under">Filed under: Pay someone</p>
        <h2>Paying an invoice (for clients)</h2>
        <p>
          <strong>When to use it:</strong> someone sent you a Twinnear
          pay link and you need to pay it.
        </p>
        <ol className="steps">
          <li>
            <span>
              Open the pay link. Check the seller, the amount, and what
              you are paying for. The page shows the line items, the
              tax, and the total.
            </span>
          </li>
          <li>
            <span>
              Connect with the wallet of the client account named on
              the invoice. Only that account can pay it.
            </span>
          </li>
          <li>
            <span>
              Pay the exact amount in NEAR. Your payment goes into
              escrow, held by the contract, not by the seller. It is
              released only when the seller releases it, or refunded to
              you.
            </span>
          </li>
          <li>
            <span>
              If the work was not delivered, open a dispute. It blocks
              the seller from releasing the escrow until you withdraw
              it or the seller refunds you.
            </span>
          </li>
          <li>
            <span>
              If the due date has passed and the seller stays silent,
              click Claim refund. The escrow comes back to you.
            </span>
          </li>
        </ol>
        <p className="muted">
          Limits: an invoice with no due date has no claim-refund
          escape. A dispute is your only protection then, besides
          asking the seller for a refund. A USDC invoice settles
          straight to the seller through 1Click, with no escrow, so
          pay one only if you trust the seller.
        </p>
      </div>

      <div className="card guide" id="books">
        <p className="filed-under">Filed under: Keep my books</p>
        <h2>Keep your books</h2>
        <p>
          <strong>When to use it:</strong> month end, or whenever you
          need a record of what you billed, received, and refunded.
        </p>
        <ol className="steps">
          <li>
            <span>
              Open the <Link to="/ledger">Ledger</Link>. It shows what you
              received, what is held in escrow, what is still owed to
              you, and totals per client.
            </span>
          </li>
          <li>
            <span>
              Click Export CSV. The file lists every invoice with its
              reference, seller, client, currency, amount in full
              precision, subtotal, tax, line items, description,
              status, and dates, plus TOTAL rows at the end.
            </span>
          </li>
          <li>
            <span>
              Import the file into a spreadsheet. NEAR and USDC have
              separate TOTAL rows. The two units are never added
              together.
            </span>
          </li>
        </ol>
        <p className="muted">
          The USD figures next to amounts are rough estimates from
          CoinGecko, never the settlement rate. Do not book them as
          the amount you were paid.
        </p>
      </div>

      <div className="card guide" id="mainnet-readiness">
        <p className="filed-under">Filed under: Get paid</p>
        <h2>Move to mainnet</h2>
        <p>
          <strong>When to use it:</strong> you want to run Twinnear on
          NEAR mainnet instead of testnet.
        </p>
        <ol className="steps">
          <li>
            <span>
              Deploy the same contract wasm to a mainnet account. The
              contract has no testnet-only logic, so no code change is
              needed.
            </span>
          </li>
          <li>
            <span>
              Point the frontend at mainnet: set NETWORK_ID,
              CONTRACT_ID, and RPC_URL in
              frontend/src/lib/config.ts, and the WalletConnect chainId
              in frontend/src/lib/near.ts.
            </span>
          </li>
          <li>
            <span>
              Point the relayer at mainnet by changing its environment
              variables only. No code change is needed.
            </span>
          </li>
          <li>
            <span>
              Budget about 2.5 NEAR for the deploy: about 2.1 NEAR of
              storage stake for the 213 KB wasm, plus account creation
              and gas. This is an estimate, not a fixed price.
            </span>
          </li>
        </ol>
        <p className="muted">
          Limits: 1Click is already mainnet-live, so cross-chain USDC
          settlement works on mainnet as designed. The deploy path is
          the same CLI path in DEPLOY.md, with the testnet network
          config replaced by mainnet. The app has no testnet/mainnet
          toggle, and the hackathon allows testnet-only entries, so the
          app stays on testnet. Do not confuse the payout address with
          a deploy: the hackathon form asks for a NEAR mainnet account
          as a payout address, and a free implicit account (a
          64-character hex address) is enough for that.
        </p>
      </div>

      <p className="muted">
        Something missing? Open an issue on the{" "}
        <a
          href="https://github.com/0xward/Twinnear"
          target="_blank"
          rel="noreferrer"
        >
          Twinnear repo
        </a>
        .
      </p>
    </div>
  );
}
